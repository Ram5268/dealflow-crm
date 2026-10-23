import { NextResponse } from 'next/server'
import type { NextRequest } from 'next/server'
import { isExemptPath } from './basicAuth'

// Brief 50 (PR 18), engineering precaution (the planner's review, Brief 50
// Revision 2, 2026-10-23): every save in the CRM answers only the CRM's own
// pages. The browser re-sends the CRM's saved Basic-auth password by itself,
// even on a request another website's page starts, and most routes read JSON
// whatever the Content-Type (src/lib/shared/http.ts parseBody). So without
// this a cross-site `<form enctype="text/plain">` or a no-cors fetch, neither
// of which needs CORS permission, could edit a lead, add to a list, or confirm
// a calling-hours policy (one of the calling gates). Brief 50 PR 16 had this
// check on POST /api/compliance/dnc/internal only; it lives here now, once,
// and the middleware runs it on every request after the password wall.
//
// What it refuses: any request that can change something (every method but
// GET, HEAD and OPTIONS) unless the browser's own headers say it came from
// this site. Browsers set these headers themselves; a page can't set or
// forge them. In order:
//   1. `Sec-Fetch-Site` (every current browser): `cross-site` or `same-site`
//      (another site started it) is refused, whatever the other headers say.
//   2. Then `Origin`, when present (every current browser sends it on every
//      POST, PUT, PATCH and DELETE): its host must be this request's own
//      host. `null` (a sandboxed frame, a data: page, a no-referrer form) and
//      anything unreadable are refused. This comes BEFORE trusting
//      `Sec-Fetch-Site: same-origin`, because WebKit (Safari) gets that one
//      wrong on a history re-send: when the person goes Back (or another
//      site's page calls history.back() over a frame of the CRM) to a POST
//      that was refused, WebKit sends the same form again with
//      `Sec-Fetch-Site: same-origin` but the original `Origin` (the other
//      site's, or `null`). Seen in Playwright's WebKit, 2026-10-23 (Brief 50
//      PR 18 review); Chromium keeps `cross-site` there. On Vercel the Origin
//      of a CRM page always matches the Host/X-Forwarded-Host (the comparison
//      Next.js itself makes for Server Actions), so this costs nothing.
//   3. No Origin: `Sec-Fetch-Site: same-origin` (a CRM page) or `none` (the
//      person started it themselves, e.g. a reload) passes; any other value
//      is refused.
//   4. No Origin and no Sec-Fetch-Site: the `Referer`'s host must be this
//      request's own host.
//   5. None of the three: refused (a deliberate choice, Brief 50 PR 18). A
//      current browser always sends Origin here, so this is a script or an
//      old browser, and an old browser that sends none of them could be
//      carrying another site's form. A script sends the password itself and
//      can send a matching `Origin` header too (e.g. curl -H "Origin: <the
//      CRM's address>"); nothing in the CRM, its scripts or DealFlow posts to
//      a non-exempt route without one.
//
// Exempt: the machine routes the password wall already exempts
// (BASIC_AUTH_EXEMPT_PATHS: Twilio webhooks, crons, Gmail push, the two
// resume routes). Their callers aren't browsers and send no Origin; each
// checks its own signature or secret.
//
// Next.js Server Actions check the Origin the same way; the CRM has none.
//
// Runtime note: middleware runs on the Edge runtime; this file uses only URL,
// Headers and NextResponse.

const NEVER_CHANGES_ANYTHING = new Set(['GET', 'HEAD', 'OPTIONS'])

export const CROSS_SITE_MESSAGE =
  "Refused: this change didn't come from the CRM's own pages. Open the CRM and try again."

export type SameOriginVerdict =
  | { allowed: true; by: 'read-only-method' | 'exempt-machine-route' | 'origin' | 'sec-fetch-site' | 'referer' }
  | {
      allowed: false
      by:
        | 'browser-says-another-site'
        | 'origin-null'
        | 'origin-unreadable'
        | 'origin-another-site'
        | 'sec-fetch-site-not-same-origin'
        | 'referer-another-site'
        | 'no-origin-sec-fetch-site-or-referer'
    }

export function checkSameOrigin(req: NextRequest): SameOriginVerdict {
  if (NEVER_CHANGES_ANYTHING.has(req.method.toUpperCase())) return { allowed: true, by: 'read-only-method' }
  if (isExemptPath(req.nextUrl.pathname)) return { allowed: true, by: 'exempt-machine-route' }

  const site = req.headers.get('sec-fetch-site')?.trim().toLowerCase() ?? null
  if (site === 'cross-site' || site === 'same-site') return { allowed: false, by: 'browser-says-another-site' }

  // Origin decides before a `same-origin` Sec-Fetch-Site is trusted (WebKit's
  // history re-send, see the note above).
  const origin = req.headers.get('origin')
  if (origin !== null) {
    if (origin.trim().toLowerCase() === 'null') return { allowed: false, by: 'origin-null' }
    const host = hostOf(origin)
    if (host === null) return { allowed: false, by: 'origin-unreadable' }
    return ownHosts(req).has(host) ? { allowed: true, by: 'origin' } : { allowed: false, by: 'origin-another-site' }
  }

  if (site !== null) {
    return site === 'same-origin' || site === 'none'
      ? { allowed: true, by: 'sec-fetch-site' }
      : { allowed: false, by: 'sec-fetch-site-not-same-origin' }
  }

  const referer = req.headers.get('referer')
  if (referer !== null) {
    const host = hostOf(referer)
    return host !== null && ownHosts(req).has(host)
      ? { allowed: true, by: 'referer' }
      : { allowed: false, by: 'referer-another-site' }
  }

  return { allowed: false, by: 'no-origin-sec-fetch-site-or-referer' }
}

// The middleware's answer: null to carry on, or the 403 to return instead.
// The route never sees a refused request, so nothing is read or written.
export function refuseCrossSiteSave(req: NextRequest): NextResponse | null {
  const verdict = checkSameOrigin(req)
  if (verdict.allowed) return null

  // One line, no body and no credentials: the method, the path, why, and the
  // browser headers that decided it (another site's address isn't private).
  console.warn('Refused a save from outside the CRM', {
    method: req.method,
    path: req.nextUrl.pathname,
    why: verdict.by,
    origin: req.headers.get('origin'),
    secFetchSite: req.headers.get('sec-fetch-site'),
  })
  return NextResponse.json(
    { error: CROSS_SITE_MESSAGE, code: 'cross_site_request' },
    { status: 403, headers: { 'Cache-Control': 'no-store' } },
  )
}

// The host (name and port) of an http(s) address, lower-cased; null when it
// isn't one.
function hostOf(value: string): string | null {
  try {
    const url = new URL(value.trim())
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null
    return url.host || null
  } catch {
    return null
  }
}

// The host this request was sent to: its address, its Host header, and the
// first X-Forwarded-Host (set by Vercel's proxy). Same as Brief 50 PR 16's
// reviewed check. Another site's page can't set any of them: a browser sets
// Host itself and won't let a page add a custom header to a request it sends
// without the CRM's permission (CORS), which the CRM never grants.
function ownHosts(req: NextRequest): Set<string> {
  const hosts = new Set<string>([new URL(req.url).host])
  for (const value of [req.headers.get('host'), req.headers.get('x-forwarded-host')?.split(',')[0]]) {
    const host = value?.trim().toLowerCase()
    if (host) hosts.add(host)
  }
  hosts.delete('')
  return hosts
}
