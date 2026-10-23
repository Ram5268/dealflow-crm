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
// own pages may post here from a browser. Brief 50 (PR 18) moved that check
// into the middleware (src/lib/auth/sameOrigin.ts), where it covers every save
// in the CRM: a request from another website gets a 403 there and never
// reaches this route, so nothing is read or written.
export async function POST(req: Request) {
  const correlationId = correlationIdFrom(req)
  const log = logWith(correlationId)

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
