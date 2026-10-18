import { NextResponse } from 'next/server'
import { prisma } from '@/lib/compliance/db'
import { getCurrentOrgId } from '@/lib/shell/orgContext'
import { correlationIdFrom, CORRELATION_HEADER } from '@/lib/compliance/correlation'
import { logWith } from '@/lib/compliance/logger'
import { storedForms } from '@/lib/compliance/dnc/internal'
import { toE164 } from '@/lib/shared/phone'

export const dynamic = 'force-dynamic'

// GET /api/compliance/dnc/suppressions?phone=E164 — every suppression on a
// phone (federal | state:XX | internal), for support/debug. Brief 41 (H13): any
// format finds it ("917-555-0147", "+19175550147", and "+1…" typed unencoded
// in a URL, which arrives as " 1…"), including rows stored in an older format;
// the reply names the canonical number. 400 if it isn't a phone number.
export async function GET(req: Request) {
  const correlationId = correlationIdFrom(req)
  const log = logWith(correlationId)
  const url = new URL(req.url)
  const phoneParam = url.searchParams.get('phone')
  if (!phoneParam) {
    return NextResponse.json({ error: 'phone query param (E.164) is required' }, { status: 400 })
  }
  const phone = toE164(phoneParam)
  if (!phone) {
    return NextResponse.json({ error: 'phone is not a valid phone number' }, { status: 400 })
  }

  try {
    const orgId = await getCurrentOrgId()
    const rows = await prisma.dncSuppression.findMany({
      where: { organizationId: orgId, phone: { in: [...new Set([...storedForms(phone), ...storedForms(phoneParam)])] } },
      select: { source: true, addedAt: true, addedBy: true, reason: true },
      orderBy: { addedAt: 'desc' },
    })
    return NextResponse.json(
      {
        phone,
        suppressions: rows.map((r) => ({
          source: r.source,
          addedAt: r.addedAt.toISOString(),
          addedBy: r.addedBy,
          reason: r.reason,
        })),
      },
      { headers: { [CORRELATION_HEADER]: correlationId } }
    )
  } catch (err) {
    log.error({ err: String(err) }, 'dnc/suppressions failed')
    return NextResponse.json({ error: 'internal_error' }, { status: 500 })
  }
}
