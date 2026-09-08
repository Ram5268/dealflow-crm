import { NextResponse } from 'next/server'
import type { NextRequest } from 'next/server'

// HTTP Basic auth gate. This is a lightweight "keep the public out" measure for
// the Vercel deploy — not a real identity system. There is no user table, no
// session, and no cookie: the browser's native auth prompt is the entire UI.
// When a real auth solution lands, delete this file and the basicAuth() call in
// ../../middleware.ts.
//
// Runtime note: middleware runs on the Edge runtime, so `node:crypto` (and its
// timingSafeEqual) is unavailable. constantTimeEquals below is the Edge-safe
// equivalent. Edge also INLINES process.env at build time — see .env.example.

const DEFAULT_USER = 'ryan'
const REALM = 'DealFlow CRM'

// Exclusions live here (not in middleware matcher config) so that the
// middleware still executes on webhook/cron routes and correlation IDs
// continue to be set. Moving these to the matcher would silently disable
// observability on the very routes we most need to trace.
//
// Two reasons a route lands here, and every entry already enforces its own
// auth — excluding them removes no protection:
//
//   1. External caller that cannot send Basic credentials at all (Twilio,
//      Google Pub/Sub). Each verifies a request signature or shared token.
//   2. `Authorization: Bearer ${CRON_SECRET}` collision. Basic auth uses the
//      SAME header, so gating these would not merely protect them — it would
//      make them permanently uncallable.
//
// Matched exactly, not by prefix: a new webhook or cron route must be added
// here deliberately rather than inheriting an exemption it was never reviewed
// for.
export const BASIC_AUTH_EXEMPT_PATHS: readonly string[] = [
  // (1) External callers — signature/token verified in the route handler.
  '/api/telephony/webhook/voice',
  '/api/telephony/webhook/status',
  '/api/telephony/webhook/recording',
  '/api/telephony/voice/conference',
  '/api/comms/webhook/sms',
  '/api/comms/webhook/gmail-push',
  // (2) Authorization: Bearer CRON_SECRET — header collision with Basic.
  '/api/cron/dealflow-signal-sync',
  '/api/cron/dnc-refresh',
  '/api/cron/gmail-sync',
  '/api/cron/graph-sync',
  '/api/cron/holiday-refresh',
  '/api/cron/sequences-tick',
  '/api/telephony/pacing/resume',
  '/api/compliance/circuit/resume',
]

export type BasicAuthResult =
  | { ok: true }
  | { ok: false; response: NextResponse }

let warnedDisabled = false

// Returns { ok: true } to let the request through, or { ok: false, response }
// carrying the 401 the middleware should return instead of continuing.
export function basicAuth(req: NextRequest): BasicAuthResult {
  const password = process.env.BASIC_AUTH_PASSWORD ?? ''

  // Unset or empty password disables the gate entirely. This is the local-dev
  // and E2E path: no prompt, no credentials to thread through Playwright.
  if (password === '') {
    if (!warnedDisabled) {
      warnedDisabled = true
      console.warn(
        '⚠️ Basic auth DISABLED — set BASIC_AUTH_PASSWORD to enable',
      )
    }
    return { ok: true }
  }

  if (isExemptPath(req.nextUrl.pathname)) return { ok: true }

  const user = process.env.BASIC_AUTH_USER || DEFAULT_USER
  const supplied = decodeBasicCredentials(req.headers.get('authorization'))

  // Compare the whole "user:password" pair in one pass: a single constant-time
  // comparison leaks neither which half was wrong nor where it diverged, and it
  // stays correct for passwords containing ':'.
  if (supplied === null || !constantTimeEquals(supplied, `${user}:${password}`)) {
    return { ok: false, response: unauthorized() }
  }

  return { ok: true }
}

export function isExemptPath(pathname: string): boolean {
  // Next serves /foo and /foo/ as the same route; normalize so a trailing
  // slash cannot smuggle a request past the exemption check in either
  // direction.
  const normalized =
    pathname.length > 1 && pathname.endsWith('/')
      ? pathname.slice(0, -1)
      : pathname
  return BASIC_AUTH_EXEMPT_PATHS.includes(normalized)
}

// Returns the decoded "user:password" string, or null when the header is
// missing, is not the Basic scheme, or is not decodable base64.
function decodeBasicCredentials(header: string | null): string | null {
  if (!header) return null

  const [scheme, encoded] = header.split(' ')
  // RFC 7235: the auth scheme token is case-insensitive.
  if (scheme?.toLowerCase() !== 'basic' || !encoded) return null

  try {
    return atob(encoded)
  } catch {
    return null
  }
}

// Edge-safe constant-time string comparison. Accumulates every byte difference
// instead of returning early, so the time taken does not depend on how much of
// the credential matched. Length is folded into the accumulator rather than
// short-circuited, which is what keeps a wrong-length password from being
// distinguishable by timing.
function constantTimeEquals(a: string, b: string): boolean {
  const encoder = new TextEncoder()
  const ab = encoder.encode(a)
  const bb = encoder.encode(b)

  let diff = ab.length ^ bb.length
  const max = Math.max(ab.length, bb.length)
  for (let i = 0; i < max; i++) {
    diff |= (i < ab.length ? ab[i] : 0) ^ (i < bb.length ? bb[i] : 0)
  }

  return diff === 0
}

function unauthorized(): NextResponse {
  // Plain text, not HTML: the browser overlays its own credential prompt and
  // the body is only seen after the user cancels out of it.
  return new NextResponse('Authentication required.', {
    status: 401,
    headers: {
      'WWW-Authenticate': `Basic realm="${REALM}"`,
      'Content-Type': 'text/plain; charset=utf-8',
    },
  })
}
