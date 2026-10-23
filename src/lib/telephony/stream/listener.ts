import { Client } from 'pg'
import { logger } from '@/lib/logger'

/**
 * One shared `LISTEN crm_call` connection per server instance, fanned out to
 * every open call-status stream (Brief 50 PR 1, open item 6.1; finding M1 of
 * the 2026-10-05 audit; engineering precautions).
 *
 * The SSE bridge used to open a dedicated pg connection for every open page in
 * every tab, with no 'error' handler: a connection Railway dropped crashed the
 * function, and many tabs could use up the database's connections. Now:
 *  - the first subscriber opens the connection and later ones share it;
 *  - the connection is let go when the last subscriber leaves;
 *  - on 'error' or an unexpected 'end' the connection is dropped and every
 *    subscriber is told (`onDrop`), so its stream closes and the browser
 *    reconnects later; nothing is thrown;
 *  - a failed connect rejects the waiting subscribers; the next one retries;
 *  - a connection that goes quiet without an 'error' or 'end' (a proxy whose
 *    far side died: the socket still looks open) is caught by a `SELECT 1`
 *    every minute that must answer within 10 s, and dropped like any other.
 *    Sharing means one dead connection would otherwise silence every stream
 *    on the instance for as long as any of them stays open; the LISTEN itself
 *    has the same time limit, so a hung one can't hold the waiting streams.
 *
 * Read-only: it only listens. Emitting stays with `telephony/events/emit.ts`.
 */

/** The Postgres channel the dialer emits call events on. */
export const CALL_CHANNEL = 'crm_call'

/** How often the open connection is checked, and how long a check (or the LISTEN) may take. */
export const PING_MS = 60_000
export const QUERY_TIMEOUT_MS = 10_000

export interface CallListenerOptions {
  pingMs?: number
  queryTimeoutMs?: number
}

/** The part of a pg Client the listener uses (a stand-in in unit tests). */
export interface ListenClient {
  connect(): Promise<unknown>
  query(text: string): Promise<unknown>
  end(): Promise<unknown>
  on(event: 'notification', listener: (msg: { channel: string; payload?: string }) => void): unknown
  on(event: 'error', listener: (err: Error) => void): unknown
  on(event: 'end', listener: () => void): unknown
}

export interface CallSubscriber {
  /** One raw JSON payload from the channel, exactly as emitted. */
  onEvent(payload: string): void
  /** The shared connection broke. The subscriber has already been removed. */
  onDrop(): void
}

export interface CallListener {
  /** Resolves with a `leave` function once the LISTEN is in place. */
  subscribe(subscriber: CallSubscriber): Promise<() => void>
  stats(): { subscribers: number; open: boolean }
  /** Drops the connection and tells every subscriber (tests, shutdown). */
  close(): Promise<void>
}

interface Connection {
  client: ListenClient
  ready: Promise<void>
  /** Subscribers still waiting for `ready`; the connection stays while any are. */
  waiting: number
  ping?: ReturnType<typeof setInterval>
}

/** `p`, or a rejection once `ms` have passed without an answer. */
function withTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const late = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${what} got no answer in ${ms} ms`)), ms)
  })
  return Promise.race([p, late]).finally(() => clearTimeout(timer))
}

export function createCallListener(newClient: () => ListenClient, opts: CallListenerOptions = {}): CallListener {
  const { pingMs = PING_MS, queryTimeoutMs = QUERY_TIMEOUT_MS } = opts
  const subscribers = new Set<CallSubscriber>()
  let current: Connection | null = null

  /** Lets a connection go. Anything it emits afterwards is ignored. */
  function release(conn: Connection): void {
    if (current === conn) current = null
    clearInterval(conn.ping)
    void conn.client.end().catch(() => {})
  }

  function drop(conn: Connection, reason: string, err?: unknown): void {
    if (current !== conn) return // already let go: a late 'end' or 'error'
    const told = [...subscribers]
    subscribers.clear()
    release(conn)
    logger.warn(
      { reason, err: err instanceof Error ? err.message : undefined, subscribers: told.length },
      'crm_call stream listener dropped; its streams were closed and browsers will reconnect',
    )
    for (const s of told) {
      try {
        s.onDrop()
      } catch {
        /* a stream that is already gone */
      }
    }
  }

  function open(): Connection {
    const client = newClient()
    const conn = { client, waiting: 0 } as Connection
    // Handlers go on before connect(): an 'error' event with no listener is
    // thrown, which is the crash this module exists to prevent.
    client.on('error', (err) => drop(conn, 'error', err))
    client.on('end', () => drop(conn, 'end'))
    client.on('notification', (msg) => {
      if (current !== conn || msg.channel !== CALL_CHANNEL || !msg.payload) return
      let removed = false
      for (const s of [...subscribers]) {
        try {
          s.onEvent(msg.payload)
        } catch {
          subscribers.delete(s) // its stream is closed; it will not be back
          removed = true
        }
      }
      if (removed && subscribers.size === 0 && conn.waiting === 0) release(conn)
    })
    conn.ready = (async () => {
      await client.connect()
      if (current !== conn) return
      await withTimeout(client.query(`LISTEN ${CALL_CHANNEL}`), queryTimeoutMs, 'LISTEN')
      if (current !== conn) return
      conn.ping = setInterval(() => {
        withTimeout(client.query('SELECT 1'), queryTimeoutMs, 'ping').catch((err) => drop(conn, 'ping failed', err))
      }, pingMs)
      conn.ping.unref?.()
    })()
    // Every subscriber awaits `ready`; this only keeps a failure that nobody
    // is waiting for from surfacing as an unhandled rejection.
    conn.ready.catch(() => {})
    current = conn
    return conn
  }

  async function subscribe(subscriber: CallSubscriber): Promise<() => void> {
    const conn = current ?? open()
    conn.waiting += 1
    try {
      await conn.ready
    } catch (err) {
      drop(conn, 'connect failed', err)
      throw err
    } finally {
      conn.waiting -= 1
    }
    if (current !== conn) throw new Error('crm_call listener dropped while connecting')
    subscribers.add(subscriber)
    let left = false
    return () => {
      if (left) return
      left = true
      subscribers.delete(subscriber)
      if (subscribers.size === 0 && conn.waiting === 0 && current === conn) release(conn)
    }
  }

  return {
    subscribe,
    stats: () => ({ subscribers: subscribers.size, open: current !== null }),
    async close() {
      if (current) drop(current, 'closed')
    },
  }
}

// One per server instance (process). Kept on globalThis so Next's dev reload
// doesn't leave an old module's connection behind (same as src/lib/prisma).
const g = globalThis as unknown as { crmCallListener?: CallListener }

export function sharedCallListener(): CallListener {
  g.crmCallListener ??= createCallListener(
    () =>
      new Client({
        connectionString: process.env.DATABASE_URL_MAIN,
        // Names the connection in pg_stat_activity.
        application_name: 'crm-call-stream',
        // A connect that hangs fails (and is retried by the browser) instead
        // of holding every waiting stream.
        connectionTimeoutMillis: 10_000,
      }),
  )
  return g.crmCallListener
}
