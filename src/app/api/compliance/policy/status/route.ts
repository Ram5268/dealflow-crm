import { NextResponse } from 'next/server'
import { prisma } from '@/lib/compliance/db'
import { getCurrentOrgId } from '@/lib/shell/orgContext'
import { correlationIdFrom, CORRELATION_HEADER } from '@/lib/compliance/correlation'
import { logWith } from '@/lib/compliance/logger'
import { getPolicyStatus } from '@/lib/compliance/policy/status'

export const dynamic = 'force-dynamic'

// GET /api/compliance/policy/status — configured windows + which timezones
// still need a confirmed policy before their contacts can be dialed.
export async function GET(req: Request) {
  const correlationId = correlationIdFrom(req)
  const log = logWith(correlationId)
  try {
    const orgId = await getCurrentOrgId()
    const status = await getPolicyStatus(orgId, prisma as any)
    return NextResponse.json(status, { headers: { [CORRELATION_HEADER]: correlationId } })
  } catch (err) {
    log.error({ err: String(err) }, 'policy/status failed')
    return NextResponse.json({ error: 'internal_error' }, { status: 500 })
  }
}
