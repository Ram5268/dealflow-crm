import { NextResponse } from 'next/server'
import { getCurrentOrgId } from '@/lib/shell/orgContext'
import { correlationIdFrom, CORRELATION_HEADER } from '@/lib/compliance/correlation'
import { logWith } from '@/lib/compliance/logger'
import { addInternalDnc } from '@/lib/compliance/dnc/internal'

export const dynamic = 'force-dynamic'

// POST /api/compliance/dnc/internal — add a phone to the org's internal DNC.
// Consumed by Agent D on SMS STOP. Idempotent: re-adding returns HTTP 201 with
// added:false (D uses `added` to distinguish new opt-outs from re-observations).
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
    log.error({ err: String(err) }, 'dnc/internal failed')
    return NextResponse.json({ error: 'internal_error' }, { status: 500 })
  }
}
