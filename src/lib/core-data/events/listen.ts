import { Client } from 'pg'
import { prisma } from '@/lib/prisma'
import { logger } from '@/lib/logger'
import { captureException } from '@/lib/shared/sentry'
import { dispatch, type Channel, type DemuxHandlers } from './demux'
import { HANDLERS } from './handlers'

// ─────────────────────────────────────────────────────────────────────────────
// LISTEN/NOTIFY consumer. One long-lived pg Client (separate from Prisma's pool)
// listens on the consumed channels and hands each payload to the shape-based
// demux. Oversized payloads carry an { overflow, overflowId } pointer that is
// re-fetched from NotifyOverflow. Reconnects on disconnect with capped backoff.
// ─────────────────────────────────────────────────────────────────────────────

const CONSUMED_CHANNELS: Channel[] = ['crm_call', 'crm_message', 'crm_scrub']

// Resolves a raw NOTIFY string into the full payload object, following an
// overflow pointer when present.
export async function resolvePayload(raw: string): Promise<Record<string, unknown>> {
  const parsed = JSON.parse(raw) as Record<string, unknown>
  if (parsed.overflow === true && typeof parsed.overflowId === 'string') {
    const row = await prisma.notifyOverflow.findUnique({ where: { id: parsed.overflowId } })
    if (!row) throw new Error(`NotifyOverflow ${parsed.overflowId} not found`)
    return row.payload as Record<string, unknown>
  }
  return parsed
}

export async function handleNotification(
  channel: Channel,
  raw: string,
  handlers: DemuxHandlers = HANDLERS
): Promise<void> {
  let payload: Record<string, unknown>
  try {
    payload = await resolvePayload(raw)
  } catch (err) {
    captureException(err, { event: 'listen.resolve', dependency: channel })
    return
  }
  try {
    await dispatch(channel, payload, handlers)
  } catch (err) {
    // Handler failure: Sentry + swallow so the listener stays alive. pg-boss
    // retry semantics apply when the handlers are wrapped as jobs (USE_PGBOSS).
    captureException(err, { event: 'listen.dispatch', dependency: channel })
  }
}

export interface ListenerHandle {
  stop: () => Promise<void>
}

export async function startListeners(handlers: DemuxHandlers = HANDLERS): Promise<ListenerHandle> {
  const connectionString = process.env.DATABASE_URL_MAIN
  if (!connectionString) throw new Error('DATABASE_URL_MAIN not set for listener')

  let client: Client | null = null
  let stopped = false
  let backoff = 1000

  async function connect(): Promise<void> {
    if (stopped) return
    client = new Client({ connectionString })
    client.on('notification', (msg) => {
      if (!msg.payload) return
      void handleNotification(msg.channel as Channel, msg.payload, handlers)
    })
    client.on('error', (err) => {
      logger.error({ err: err.message }, 'listener client error')
    })
    client.on('end', () => {
      if (!stopped) scheduleReconnect()
    })
    await client.connect()
    for (const ch of CONSUMED_CHANNELS) await client.query(`LISTEN ${ch}`)
    backoff = 1000
    logger.info({ channels: CONSUMED_CHANNELS }, 'listeners started')
  }

  function scheduleReconnect(): void {
    const delay = Math.min(backoff, 60_000)
    backoff = Math.min(backoff * 2, 60_000)
    setTimeout(() => {
      connect().catch((err) => {
        logger.error({ err: err.message }, 'listener reconnect failed')
        scheduleReconnect()
      })
    }, delay)
  }

  await connect()

  return {
    stop: async () => {
      stopped = true
      if (client) await client.end().catch(() => {})
    },
  }
}
