import { NextResponse } from 'next/server'
import { getCurrentOrgId } from '@/lib/shell/orgContext'
import { correlationIdFrom, CORRELATION_HEADER } from '@/lib/compliance/correlation'
import { logWith } from '@/lib/compliance/logger'
import { isAuthorizedCron } from '@/lib/compliance/cronAuth'
import { runHolidayRefresh } from '@/lib/compliance/holidays/refresh'

export const dynamic = 'force-dynamic'

// GET /api/cron/holiday-refresh — nightly. Regenerates federal + per-state
// public holidays for this year + next and upserts them. Bearer CRON_SECRET.
export async function GET(req: Request) {
  const correlationId = correlationIdFrom(req)
  const log = logWith(correlationId)

  if (!isAuthorizedCron(req)) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  }

  try {
    const orgId = await getCurrentOrgId()
    const summary = await runHolidayRefresh({ orgId })
    log.info({ ...summary }, 'holiday-refresh complete')
    return NextResponse.json(
      { status: 'ok', ...summary },
      { headers: { [CORRELATION_HEADER]: correlationId } }
    )
  } catch (err) {
    log.error({ err: String(err) }, 'holiday-refresh failed')
    return NextResponse.json({ error: 'internal_error' }, { status: 500 })
  }
}
