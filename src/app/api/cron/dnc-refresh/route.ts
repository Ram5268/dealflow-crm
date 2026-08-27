import { NextResponse } from 'next/server'
import { getCurrentOrgId } from '@/lib/shell/orgContext'
import { correlationIdFrom, CORRELATION_HEADER } from '@/lib/compliance/correlation'
import { logWith } from '@/lib/compliance/logger'
import { isAuthorizedCron } from '@/lib/compliance/cronAuth'
import { getDncVendor } from '@/lib/compliance/dnc/vendors/index'
import { runDncRefresh } from '@/lib/compliance/dnc/refresh'

export const dynamic = 'force-dynamic'

// GET /api/cron/dnc-refresh — nightly full re-scrub. Bearer CRON_SECRET.
// Returns 503 (not a silent success) when no DNC vendor is configured.
export async function GET(req: Request) {
  const correlationId = correlationIdFrom(req)
  const log = logWith(correlationId)

  if (!isAuthorizedCron(req)) return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  if (getDncVendor().name === 'noop') {
    return NextResponse.json({ error: 'dnc_vendor_not_configured' }, { status: 503 })
  }

  try {
    const orgId = await getCurrentOrgId()
    const summary = await runDncRefresh(orgId, { correlationId })
    log.info({ ...summary }, 'dnc-refresh complete')
    return NextResponse.json({ status: 'ok', ...summary }, { headers: { [CORRELATION_HEADER]: correlationId } })
  } catch (err) {
    log.error({ err: String(err) }, 'dnc-refresh failed')
    return NextResponse.json({ error: 'internal_error' }, { status: 500 })
  }
}
