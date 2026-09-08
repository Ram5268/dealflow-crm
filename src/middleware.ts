import { NextResponse } from 'next/server'
import type { NextRequest } from 'next/server'
import { basicAuth } from '@/lib/auth/basicAuth'
import { CORRELATION_HEADER, newCorrelationId } from '@/lib/shell/correlationId'

// Runs the Basic auth gate first, then reads an inbound x-correlation-id header
// or mints one, propagating it on both the forwarded request and the response
// so the id survives the full round-trip. Route handlers wrap their work in
// runWithCorrelationId(id, ...) using this header to populate
// async-local-storage.
//
// A rejected request returns the 401 without a correlation id — there is no
// downstream work to correlate.
export function middleware(req: NextRequest) {
  const auth = basicAuth(req)
  if (!auth.ok) return auth.response

  const correlationId =
    req.headers.get(CORRELATION_HEADER) ?? newCorrelationId()

  const requestHeaders = new Headers(req.headers)
  requestHeaders.set(CORRELATION_HEADER, correlationId)

  const res = NextResponse.next({ request: { headers: requestHeaders } })
  res.headers.set(CORRELATION_HEADER, correlationId)
  return res
}

// Unchanged: the auth exemption list lives in @/lib/auth/basicAuth, NOT here,
// so that middleware still runs (and still sets correlation ids) on the routes
// the auth gate skips.
export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon.ico).*)'],
}
