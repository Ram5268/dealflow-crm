import { NextResponse } from 'next/server'
import type { NextRequest } from 'next/server'
import { CORRELATION_HEADER, newCorrelationId } from '@/lib/shell/correlationId'

// Reads an inbound x-correlation-id header or mints one, then propagates it on
// both the forwarded request and the response so the id survives the full
// round-trip. Route handlers wrap their work in runWithCorrelationId(id, ...)
// using this header to populate async-local-storage.
export function middleware(req: NextRequest) {
  const correlationId =
    req.headers.get(CORRELATION_HEADER) ?? newCorrelationId()

  const requestHeaders = new Headers(req.headers)
  requestHeaders.set(CORRELATION_HEADER, correlationId)

  const res = NextResponse.next({ request: { headers: requestHeaders } })
  res.headers.set(CORRELATION_HEADER, correlationId)
  return res
}

export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon.ico).*)'],
}
