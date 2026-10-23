import type { NextRequest } from 'next/server'
import { middleware } from '@/middleware'

// Brief 50 (PR 18): sends a request the way Next serves it. The middleware
// (the password wall, then the same-origin check) runs first, and the route
// handler sees the request only when the middleware lets it through (Next's
// "continue" answer, x-middleware-next: 1). Route tests that call a handler
// directly skip the middleware; these don't.
export async function throughMiddleware(
  req: NextRequest,
  route: (req: NextRequest) => Promise<Response> | Response,
): Promise<{ response: Response; reachedRoute: boolean }> {
  const first = middleware(req)
  if (first.headers.get('x-middleware-next') !== '1') return { response: first, reachedRoute: false }
  return { response: await route(req), reachedRoute: true }
}
