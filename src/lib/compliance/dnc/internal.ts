import { prisma as defaultPrisma } from '@/lib/compliance/db'

// Internal DNC — the org's own suppression list. Survives DealFlow re-imports
// (it's keyed on phone, not ContactPhone.id, so a re-imported contact with a
// fresh ContactPhone row is still blocked). Agent D writes here on SMS STOP.
// Cron NEVER removes internal rows (only federal/state:* rows).

// Light E.164 normalization so a re-import that formats the same number
// differently still matches the suppression row.
export function normalizeE164(raw: string): string {
  return raw.trim().replace(/[\s()\-.]/g, '')
}

export interface InternalDncRow {
  id: string
  phone: string
  addedAt: Date
}

export interface InternalDncDb {
  dncSuppression: {
    findUnique: (args: any) => Promise<InternalDncRow | null>
    findMany: (args: any) => Promise<Array<{ phone: string }>>
    create: (args: any) => Promise<InternalDncRow>
  }
}

export interface AddInternalDncResult {
  id: string
  phone: string
  source: 'internal'
  addedAt: string // ISO
  added: boolean // true = new row; false = already existed (idempotent)
}

export async function addInternalDnc(
  orgId: string,
  input: { phone: string; reason?: string; addedBy?: string },
  db: InternalDncDb = defaultPrisma as unknown as InternalDncDb
): Promise<AddInternalDncResult> {
  const phone = normalizeE164(input.phone)

  const existing = await db.dncSuppression.findUnique({
    where: { organizationId_phone_source: { organizationId: orgId, phone, source: 'internal' } },
  })
  if (existing) {
    return { id: existing.id, phone, source: 'internal', addedAt: existing.addedAt.toISOString(), added: false }
  }

  try {
    const created = await db.dncSuppression.create({
      data: {
        organizationId: orgId,
        phone,
        source: 'internal',
        addedBy: input.addedBy ?? 'user-request',
        reason: input.reason,
      },
    })
    return { id: created.id, phone, source: 'internal', addedAt: created.addedAt.toISOString(), added: true }
  } catch (err) {
    // Concurrent add lost the race on the unique (orgId, phone, source) index —
    // re-read and report idempotent existed.
    const raced = await db.dncSuppression.findUnique({
      where: { organizationId_phone_source: { organizationId: orgId, phone, source: 'internal' } },
    })
    if (raced) {
      return { id: raced.id, phone, source: 'internal', addedAt: raced.addedAt.toISOString(), added: false }
    }
    throw err
  }
}

// Batch: which of these phones are on the internal DNC list. ONE query for the
// whole callable-now batch, not N queries.
export async function internalDncHits(
  orgId: string,
  phones: string[],
  db: InternalDncDb = defaultPrisma as unknown as InternalDncDb
): Promise<Set<string>> {
  if (phones.length === 0) return new Set()
  const normalized = phones.map(normalizeE164)
  const rows = await db.dncSuppression.findMany({
    where: { organizationId: orgId, source: 'internal', phone: { in: normalized } },
    select: { phone: true },
  })
  return new Set(rows.map((r) => r.phone))
}
