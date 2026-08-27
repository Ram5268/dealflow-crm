import { NextResponse } from 'next/server'
import { getCurrentOrgId } from '@/lib/shell/orgContext'
import { correlationIdFrom, CORRELATION_HEADER } from '@/lib/compliance/correlation'
import { logWith } from '@/lib/compliance/logger'
import { confirmPolicy, PolicyValidationError } from '@/lib/compliance/policy/confirm'

export const dynamic = 'force-dynamic'

// POST /api/compliance/policy/confirm — Ryan confirms a CallingWindowConfig
// after conferring with counsel. This is the gate that unblocks dialing for a
// timezone. Invalidates the hot-path cache so the next callable-now sees it.
export async function POST(req: Request) {
  const correlationId = correlationIdFrom(req)
  const log = logWith(correlationId)

  let body: any
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: 'invalid_json' }, { status: 400 })
  }

  try {
    const orgId = await getCurrentOrgId()
    const row = await confirmPolicy(orgId, {
      timezone: body?.timezone,
      earliestHour: body?.earliestHour,
      latestHour: body?.latestHour,
      allowedDaysOfWeek: body?.allowedDaysOfWeek,
      policyConfirmedBy: body?.policyConfirmedBy,
    })
    return NextResponse.json(
      {
        timezone: row.timezone,
        earliestHour: row.earliestHour,
        latestHour: row.latestHour,
        allowedDaysOfWeek: row.allowedDaysOfWeek,
        policyConfirmedBy: row.policyConfirmedBy,
        policyConfirmedAt: row.policyConfirmedAt ? row.policyConfirmedAt.toISOString() : null,
      },
      { status: 201, headers: { [CORRELATION_HEADER]: correlationId } }
    )
  } catch (err) {
    if (err instanceof PolicyValidationError) {
      return NextResponse.json({ error: err.message }, { status: 400 })
    }
    log.error({ err: String(err) }, 'policy/confirm failed')
    return NextResponse.json({ error: 'internal_error' }, { status: 500 })
  }
}
