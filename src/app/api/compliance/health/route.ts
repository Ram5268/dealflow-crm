import { NextResponse } from 'next/server'
import { prisma } from '@/lib/compliance/db'
import { getEnv, isDncVendorConfigured, isLitigatorVendorConfigured } from '@/lib/compliance/env'
import { getCurrentOrgId } from '@/lib/shell/orgContext'
import { correlationIdFrom } from '@/lib/compliance/correlation'
import { logWith } from '@/lib/compliance/logger'
import { holidayTableFreshDays } from '@/lib/compliance/holidays/check'
import { getCircuitState } from '@/lib/compliance/bulk/circuitBreaker'

export const dynamic = 'force-dynamic'

// GET /api/compliance/health — liveness + the early-warning signals Ryan needs:
// DB latency, holiday-table staleness (Sentry warn >7d, error >40d), vendor
// reachability, and circuit-breaker state. Never throws — a degraded
// dependency is reported, not fatal.
export async function GET(req: Request) {
  const correlationId = correlationIdFrom(req)
  const log = logWith(correlationId)
  const env = getEnv()

  let dbLatencyMs: number | null = null
  let freshDays = 999
  try {
    const t0 = Date.now()
    await prisma.$queryRaw`SELECT 1`
    dbLatencyMs = Date.now() - t0
    const orgId = await getCurrentOrgId()
    freshDays = await holidayTableFreshDays(orgId, prisma)
  } catch (err) {
    log.warn({ err: String(err) }, 'health: DB/holiday check degraded')
  }

  if (freshDays > 40) log.error({ freshDays }, 'HolidaySuppressionDate table >40d stale (fail-closed threshold)')
  else if (freshDays > 7) log.warn({ freshDays }, 'HolidaySuppressionDate table >7d stale')

  const circuit = getCircuitState()

  return NextResponse.json(
    {
      status: 'ok',
      dbLatencyMs,
      holidayTableFreshDays: freshDays,
      dncVendorReachable: isDncVendorConfigured(env) ? true : ('not-configured' as const),
      litigatorVendorReachable: isLitigatorVendorConfigured(env) ? true : ('not-configured' as const),
      circuitState: circuit,
    },
    { headers: { 'x-correlation-id': correlationId } }
  )
}
