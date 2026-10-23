import { prisma as defaultPrisma } from '@/lib/compliance/db'
import { toE164 } from '@/lib/shared/phone'

// Internal DNC — the org's own suppression list. Survives DealFlow re-imports
// (it's keyed on phone, not ContactPhone.id, so a re-imported contact with a
// fresh ContactPhone row is still blocked). Agent D writes here on SMS STOP.
// Cron NEVER removes internal rows (only federal/state:* rows).

// Brief 41 (H13): the form a phone is stored and matched in: canonical E.164
// ("917-555-0147" → "+19175550147"). It used to only strip punctuation, so an
// opt-out typed "917-555-0147" was stored as "9175550147" and never matched the
// lead's "+19175550147". A value that isn't a phone number keeps the old
// punctuation-stripped form.
export function normalizeE164(raw: string): string {
  return toE164(raw) ?? raw.trim().replace(/[\s()\-.]/g, '')
}

// Every form the same number may be stored in from before Brief 41 (until the
// backfill rewrites them): canonical, as typed without punctuation, and for a
// US number its 10- and 11-digit forms.
//
// Brief 50 PR 17 (the planner's review, Brief 50 Revision 2, 2026-10-23): and
// for a US number, "+" followed by its 10 digits ("+9175550147" for
// +19175550147). Before Brief 50 PR 13 the parser read an opt-out typed
// "+917 555 0147" as a foreign number and stored it that way, so the lead's
// +19175550147 never matched it. This only adds a form, so matching only gets
// broader: a call check never stops blocking anything it blocked. It stays
// until Brief 50's data step DS-1 (scripts/brief41-canonical-phones.ts
// --apply) has rewritten the stored opt-outs and phones; then it can go.
export function storedForms(raw: string): string[] {
  const canonical = normalizeE164(raw)
  const forms = new Set([canonical, raw.trim().replace(/[\s()\-.]/g, '')])
  if (/^\+1\d{10}$/.test(canonical)) {
    forms.add(canonical.slice(1))
    forms.add(canonical.slice(2))
    forms.add(`+${canonical.slice(2)}`)
  }
  return [...forms].filter(Boolean)
}

// A phone that can't be read as a phone number: the add is refused (400).
export class InvalidPhoneError extends Error {
  constructor(readonly input: string) {
    super('not a valid phone number')
  }
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
  const phone = toE164(input.phone)
  if (!phone) throw new InvalidPhoneError(input.phone)

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

// Batch: which of these phones are on the internal DNC list, as their
// normalizeE164 form (what callers look up). ONE query for the whole
// callable-now batch, not N queries. Rows stored in an older format still
// match (storedForms). Brief 50 PR 17: the lead page and the lead's edits ask
// this too (src/lib/core-data/leads/opt-out.ts), so a number the call checks
// treat as an opt-out is the one the page locks.
export async function internalDncHits(
  orgId: string,
  phones: string[],
  db: InternalDncDb = defaultPrisma as unknown as InternalDncDb
): Promise<Set<string>> {
  if (phones.length === 0) return new Set()
  // Two phones in one batch can be the same number typed differently: keep
  // every form of each (a Map entry would otherwise be overwritten).
  const formsOf = new Map<string, string[]>()
  for (const p of phones) {
    const key = normalizeE164(p)
    formsOf.set(key, [...new Set([...(formsOf.get(key) ?? []), ...storedForms(p)])])
  }
  const rows = await db.dncSuppression.findMany({
    where: { organizationId: orgId, source: 'internal', phone: { in: [...new Set([...formsOf.values()].flat())] } },
    select: { phone: true },
  })
  const found = new Set(rows.map((r) => r.phone))
  return new Set([...formsOf].filter(([, forms]) => forms.some((f) => found.has(f))).map(([key]) => key))
}
