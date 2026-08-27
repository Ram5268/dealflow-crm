import { logger } from '@/lib/logger'

// ─────────────────────────────────────────────────────────────────────────────
// Shape-based event dispatcher (brief §6). Routing is by (channel, payload
// shape) — there is NO `eventName` discriminant. Each channel has an ordered
// demux table of predicate → handler-key. Unknown shapes are logged at info and
// ignored; the listener NEVER crashes on an unrecognized payload.
// ─────────────────────────────────────────────────────────────────────────────

export type Channel = 'crm_call' | 'crm_message' | 'crm_scrub' | 'crm_lead_sync'

export type HandlerKey =
  | 'call.connected'
  | 'call.completed'
  | 'dial-session.pacing-update'
  | 'message.received'
  | 'scrub.completed'

type Payload = Record<string, unknown>

interface DemuxRule {
  key: HandlerKey
  predicate: (p: Payload) => boolean
}

const has = (p: Payload, k: string) => Object.prototype.hasOwnProperty.call(p, k)

const DEMUX: Record<Channel, DemuxRule[]> = {
  crm_call: [
    { key: 'call.connected', predicate: (p) => has(p, 'callId') && has(p, 'connectedAt') },
    { key: 'call.completed', predicate: (p) => has(p, 'callId') && has(p, 'disposition') },
    {
      key: 'dial-session.pacing-update',
      predicate: (p) => has(p, 'dialSessionId') && has(p, 'currentLineCount'),
    },
  ],
  crm_message: [
    { key: 'message.received', predicate: (p) => has(p, 'messageId') && has(p, 'channel') },
  ],
  crm_scrub: [
    { key: 'scrub.completed', predicate: (p) => has(p, 'phoneCount') && has(p, 'blockedCount') },
  ],
  crm_lead_sync: [],
}

// Pure: which handler (if any) a payload maps to on a channel.
export function matchShape(channel: Channel, payload: Payload): HandlerKey | null {
  const rules = DEMUX[channel] ?? []
  for (const r of rules) {
    if (r.predicate(payload)) return r.key
  }
  return null
}

export interface DemuxHandlers {
  'call.connected': (p: Payload) => Promise<void>
  'call.completed': (p: Payload) => Promise<void>
  'dial-session.pacing-update': (p: Payload) => Promise<void>
  'message.received': (p: Payload) => Promise<void>
  'scrub.completed': (p: Payload) => Promise<void>
}

// Dispatch a payload to its handler. Returns 'handled' or 'ignored'. Never
// throws for an unknown shape — logs and returns 'ignored'.
export async function dispatch(
  channel: Channel,
  payload: Payload,
  handlers: DemuxHandlers
): Promise<'handled' | 'ignored'> {
  const key = matchShape(channel, payload)
  if (!key) {
    logger.info(
      { channel, keys: Object.keys(payload), correlationId: payload.correlationId },
      'unknown-payload-shape'
    )
    return 'ignored'
  }
  await handlers[key](payload)
  return 'handled'
}
