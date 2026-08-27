import { createHmac, timingSafeEqual, randomBytes } from 'node:crypto'

/**
 * CSRF-safe OAuth `state` (brief §2.1): an HMAC-signed, time-boxed token carried
 * through the provider round-trip. The callback verifies it before trusting the
 * `code`, so an attacker can't forge a callback that binds a token to Ryan's org.
 *
 * Format: `base64url(JSON{orgId,provider,nonce,ts})` "." `base64url(hmacSHA256)`.
 * Pure + clock-injectable → unit-testable.
 */

const DEFAULT_MAX_AGE_MS = 10 * 60 * 1000 // 10 minutes
const CLOCK_SKEW_MS = 60 * 1000

export interface StatePayload {
  orgId: string
  provider: 'gmail' | 'msft'
}

interface StateBody extends StatePayload {
  nonce: string
  ts: number
}

function secretOf(secret?: string): string {
  const s = secret ?? process.env.OAUTH_STATE_SECRET
  if (!s) throw new Error('OAUTH_STATE_SECRET is not set — cannot sign/verify OAuth state.')
  return s
}

function sign(encoded: string, secret: string): string {
  return createHmac('sha256', secret).update(encoded).digest('base64url')
}

export function signState(
  payload: StatePayload,
  opts: { secret?: string; now?: number; nonce?: string } = {},
): string {
  const body: StateBody = {
    orgId: payload.orgId,
    provider: payload.provider,
    nonce: opts.nonce ?? randomBytes(9).toString('base64url'),
    ts: opts.now ?? Date.now(),
  }
  const encoded = Buffer.from(JSON.stringify(body)).toString('base64url')
  return `${encoded}.${sign(encoded, secretOf(opts.secret))}`
}

export function verifyState(
  state: string,
  opts: { secret?: string; now?: number; maxAgeMs?: number } = {},
): StatePayload {
  const parts = state.split('.')
  if (parts.length !== 2) throw new Error('invalid state format')
  const [encoded, mac] = parts

  const expected = sign(encoded, secretOf(opts.secret))
  const macBuf = Buffer.from(mac)
  const expBuf = Buffer.from(expected)
  if (macBuf.length !== expBuf.length || !timingSafeEqual(macBuf, expBuf)) {
    throw new Error('state signature mismatch')
  }

  let body: StateBody
  try {
    body = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8'))
  } catch {
    throw new Error('state body unparseable')
  }

  const now = opts.now ?? Date.now()
  const maxAge = opts.maxAgeMs ?? DEFAULT_MAX_AGE_MS
  if (typeof body.ts !== 'number' || now - body.ts > maxAge) {
    throw new Error('state expired')
  }
  if (body.ts > now + CLOCK_SKEW_MS) {
    throw new Error('state timestamp is in the future')
  }
  if (!body.orgId || (body.provider !== 'gmail' && body.provider !== 'msft')) {
    throw new Error('state payload invalid')
  }
  return { orgId: body.orgId, provider: body.provider }
}
