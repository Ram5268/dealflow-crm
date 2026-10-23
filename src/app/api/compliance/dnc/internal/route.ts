import { NextResponse } from 'next/server'
import { getCurrentOrgId } from '@/lib/shell/orgContext'
import { correlationIdFrom, CORRELATION_HEADER } from '@/lib/compliance/correlation'
import { logWith } from '@/lib/compliance/logger'
import { addInternalDnc, InvalidPhoneError } from '@/lib/compliance/dnc/internal'

export const dynamic = 'force-dynamic'

// POST /api/compliance/dnc/internal — add a phone to the org's internal DNC.
// Idempotent: re-adding returns HTTP 201 with added:false. Brief 41 (H13): the
// number is stored in canonical E.164 however it was typed ("917-555-0147" →
// "+19175550147"); a value that isn't a phone number is refused with 400. SMS
// STOP now adds in-process (comms/sms/stop-handler.ts), not through here.
//
// Brief 50 (PR 16), engineering precaution (Brief 47's report): only the CRM's
// own pages may post here from a browser; see isCrossSiteBrowserRequest below.
export async function POST(req: Request) {
  const correlationId = correlationIdFrom(req)
  const log = logWith(correlationId)

  // Before the body is read, so a refused request writes nothing.
  if (isCrossSiteBrowserRequest(req)) {
    log.warn(
      { secFetchSite: req.headers.get('sec-fetch-site'), origin: req.headers.get('origin') },
      'dnc/internal refused a cross-site request',
    )
    return NextResponse.json({ error: 'cross_site_request' }, { status: 403, headers: { [CORRELATION_HEADER]: correlationId } })
  }

  let body: any
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: 'invalid_json' }, { status: 400 })
  }
  if (typeof body?.phone !== 'string' || body.phone.trim() === '') {
    return NextResponse.json({ error: 'phone (E.164) is required' }, { status: 400 })
  }

  try {
    const orgId = await getCurrentOrgId()
    const result = await addInternalDnc(orgId, {
      phone: body.phone,
      reason: typeof body.reason === 'string' ? body.reason : undefined,
      addedBy: typeof body.addedBy === 'string' ? body.addedBy : undefined,
    })
    return NextResponse.json(result, { status: 201, headers: { [CORRELATION_HEADER]: correlationId } })
  } catch (err) {
    if (err instanceof InvalidPhoneError) {
      return NextResponse.json({ error: 'phone is not a valid phone number' }, { status: 400, headers: { [CORRELATION_HEADER]: correlationId } })
    }
    log.error({ err: String(err) }, 'dnc/internal failed')
    return NextResponse.json({ error: 'internal_error' }, { status: 500 })
  }
}

// Brief 50 (PR 16), engineering precaution (Brief 47's report, "found but not
// fixed"): the browser re-sends the CRM's saved Basic-auth password by itself,
// even on a request another site's page starts, so without this check a
// cross-site page could make Ryan's logged-in browser add an opt-out (worst
// case: an extra opt-out; this route never removes one). The route reads JSON
// whatever the Content-Type, so a plain cross-site form or no-cors fetch would
// otherwise get through.
//
// - Sec-Fetch-Site, when the browser sends it (all current browsers), decides:
//   only 'same-origin' passes. A page can't set or forge it, and it keeps the
//   Settings form working even if a proxy rewrites the host the route sees.
// - Otherwise (older browsers) the Origin header's host must be this request's
//   own host. 'null' (a sandboxed frame, a data: page) or anything unreadable
//   is refused.
// - Neither header: not a cross-site browser page (browsers send Origin on
//   every cross-site POST), so a script or tool such as curl. It had to send
//   the password itself (the middleware's Basic-auth gate runs first), so it
//   can already do anything the CRM allows and could send a matching Origin
//   anyway. Refusing it would only break scripted adds, so it passes.
function isCrossSiteBrowserRequest(req: Request): boolean {
  const site = req.headers.get('sec-fetch-site')
  if (site !== null) return site !== 'same-origin'

  const origin = req.headers.get('origin')
  if (origin === null) return false

  let originHost: string
  try {
    originHost = new URL(origin).host
  } catch {
    return true
  }
  return !ownHosts(req).has(originHost)
}

// The host this request was sent to: its address, its Host header, and the
// first X-Forwarded-Host (set by Vercel's proxy). A cross-site page can't set
// any of them: a browser sets Host itself and won't let a page add a custom
// header to a request it sends without permission.
function ownHosts(req: Request): Set<string> {
  const hosts = new Set<string>([new URL(req.url).host])
  for (const value of [req.headers.get('host'), req.headers.get('x-forwarded-host')?.split(',')[0]]) {
    const host = value?.trim().toLowerCase()
    if (host) hosts.add(host)
  }
  return hosts
}
