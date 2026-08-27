import { NextResponse } from 'next/server'
import { prisma } from '@/lib/compliance/db'
import { getCurrentOrgId } from '@/lib/shell/orgContext'
import { correlationIdFrom, CORRELATION_HEADER } from '@/lib/compliance/correlation'
import { logWith } from '@/lib/compliance/logger'
import { isAuthorizedCron } from '@/lib/compliance/cronAuth'
import { resumeCircuit, type VendorKind } from '@/lib/compliance/bulk/circuitBreaker'
import { writeScrubLogs } from '@/lib/compliance/scrub/scrubLog'

export const dynamic = 'force-dynamic'

// POST /api/compliance/circuit/resume — operator un-halts an open vendor
// circuit-breaker after verifying the vendor is healthy. Bearer CRON_SECRET.
// Writes an audit ScrubLog row per resumed circuit.
export async function POST(req: Request) {
  const correlationId = correlationIdFrom(req)
  const log = logWith(correlationId)

  if (!isAuthorizedCron(req)) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  }

  let body: any
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: 'invalid_json' }, { status: 400 })
  }
  const circuit = body?.circuit
  if (circuit !== 'dnc' && circuit !== 'litigator' && circuit !== 'all') {
    return NextResponse.json({ error: 'circuit must be one of dnc|litigator|all' }, { status: 400 })
  }
  const operatorLabel = typeof body?.operatorLabel === 'string' ? body.operatorLabel : ''

  try {
    const orgId = await getCurrentOrgId()
    const resumed = resumeCircuit(circuit as VendorKind | 'all')
    const resumedAt = new Date()
    await writeScrubLogs(
      orgId,
      resumed.map((name) => ({
        phone: '',
        operation: name === 'dnc' ? ('check-federal' as const) : ('check-litigator' as const),
        result: 'clean' as const,
        detail: { event: 'circuit_resumed', operatorLabel, correlationId },
      })),
      prisma as any
    )
    return NextResponse.json(
      { circuits: resumed.map((name) => ({ name, state: 'closed', resumedAt: resumedAt.toISOString() })) },
      { headers: { [CORRELATION_HEADER]: correlationId } }
    )
  } catch (err) {
    log.error({ err: String(err) }, 'circuit/resume failed')
    return NextResponse.json({ error: 'internal_error' }, { status: 500 })
  }
}
