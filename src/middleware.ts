import { NextResponse } from 'next/server'
import type { NextRequest } from 'next/server'
import { basicAuth } from '@/lib/auth/basicAuth'
import { refuseCrossSiteSave } from '@/lib/auth/sameOrigin'
import { CORRELATION_HEADER, newCorrelationId } from '@/lib/shell/correlationId'

// Runs the Basic auth gate first, then the same-origin check on saves, then
// reads an inbound x-correlation-id header or mints one, propagating it on
// both the forwarded request and the response so the id survives the full
// round-trip. Route handlers wrap their work in runWithCorrelationId(id, ...)
// using this header to populate async-local-storage.
//
// A rejected request returns the 401 (or the 503 "not configured" a Vercel
// deployment with no BASIC_AUTH_PASSWORD gives, Brief 47 PR 3) without a
// correlation id — there is no downstream work to correlate.
//
// Brief 50 (PR 18), engineering precaution (the planner's review, Brief 50
// Revision 2, 2026-10-23): a request that can change something (any method
// but GET, HEAD and OPTIONS) and didn't come from the CRM's own pages gets a
// 403 here, before any route reads it. The password wall answers first, so a
// caller with no login still gets the 401 prompt. The wall's exempt machine
// routes (Twilio, crons, Gmail push) are exempt here too. See
// @/lib/auth/sameOrigin for the rule.
export function middleware(req: NextRequest) {
  const auth = basicAuth(req)
  if (!auth.ok) return auth.response

  const refused = refuseCrossSiteSave(req)
  if (refused) return refused

  const correlationId =
    req.headers.get(CORRELATION_HEADER) ?? newCorrelationId()

  const requestHeaders = new Headers(req.headers)
  requestHeaders.set(CORRELATION_HEADER, correlationId)

  const res = NextResponse.next({ request: { headers: requestHeaders } })
  res.headers.set(CORRELATION_HEADER, correlationId)
  // Brief 50 (PR 18, review round 1), engineering precaution: no other
  // website may show a CRM page inside a frame. A framed page can be steered
  // while the browser holds the login (a hidden click, or Safari re-sending a
  // refused form from history). The CRM never frames its own pages.
  res.headers.set('X-Frame-Options', 'DENY')
  res.headers.set('Content-Security-Policy', "frame-ancestors 'none'")
  return res
}

// Unchanged: the auth exemption list lives in @/lib/auth/basicAuth, NOT here,
// so that middleware still runs (and still sets correlation ids) on the routes
// the auth gate skips.
export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon.ico).*)'],
}
