import { NextResponse } from 'next/server'
import { prisma } from '@/lib/compliance/db'
import { getCurrentOrgId } from '@/lib/shell/orgContext'
import { correlationIdFrom, CORRELATION_HEADER } from '@/lib/compliance/correlation'
import { logWith } from '@/lib/compliance/logger'
import { scrubPhones } from '@/lib/compliance/scrub/scrubPhones'
import { internalDncHits } from '@/lib/compliance/dnc/internal'
import { checkDncBatch } from '@/lib/compliance/dnc/check'
import { checkLitigatorBatch } from '@/lib/compliance/litigator/check'
import { writeScrubLogs } from '@/lib/compliance/scrub/scrubLog'
import { emitScrubCompleted } from '@/lib/compliance/events/emitScrubCompleted'

export const dynamic = 'force-dynamic'

// POST /api/compliance/scrub — bulk suppression scrub. Any transaction-level
// failure returns 500 (no partial success). Emits scrub.completed on success.
export async function POST(req: Request) {
  const correlationId = correlationIdFrom(req)
  const log = logWith(correlationId)

  let body: any
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: 'invalid_json' }, { status: 400 })
  }
  const phones = body?.phones
  if (!Array.isArray(phones) || phones.some((p) => typeof p !== 'string')) {
    return NextResponse.json({ error: 'phones must be a string[]' }, { status: 400 })
  }

  try {
    const orgId = await getCurrentOrgId()
    const out = await scrubPhones(phones, {
      orgId,
      correlationId,
      now: new Date(),
      hasAnyConfirmedPolicy: async (o) =>
        (await prisma.callingWindowConfig.count({ where: { organizationId: o, policyConfirmedBy: { not: null } } })) > 0,
      internalDncHits: (o, ps) => internalDncHits(o, ps, prisma as any),
      checkDnc: (o, ps) => checkDncBatch(o, ps, { db: prisma as any, correlationId }),
      checkLitigator: (o, ps) => checkLitigatorBatch(o, ps, { db: prisma as any, correlationId }),
      persist: async (o, logs, event) => {
        await prisma.$transaction(async (tx) => {
          await writeScrubLogs(o, logs, tx as any)
          await emitScrubCompleted(event, tx as any)
        })
      },
    })
    return NextResponse.json(out, { headers: { [CORRELATION_HEADER]: correlationId } })
  } catch (err) {
    log.error({ err: String(err) }, 'scrub failed')
    return NextResponse.json({ error: 'internal_error' }, { status: 500 })
  }
}
