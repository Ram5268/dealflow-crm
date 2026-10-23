import type { Prisma } from '@prisma/client'
import { internalDncHits, normalizeE164, storedForms, type InternalDncDb } from '@/lib/compliance/dnc/internal'
import { toE164 } from '@/lib/shared/phone'
import { DO_NOT_CONTACT_LABEL, TEXTS_BLOCKED_LABEL, phoneLast4 } from './edit-text'

// Brief 50 PR 17 — a lead's numbers and the CRM's own Do not contact list
// (DncSuppression, source 'internal': Settings → Do not contact, SMS STOP, the
// STOP sweep). The list exists because a homeowner asked not to be contacted;
// nothing may call, text or email a lead [Ryan]. The planner's review (Brief 50
// Revision 2, 2026-10-23) found PR 5's lock read only the phone row's
// "texts blocked" flag, which nothing sets, so a real opt-out showed unlocked
// and its number could be changed or swapped. So:
//
// - Whether a number is on the list is decided by the call checks' own matcher
//   (internalDncHits, with every stored form it knows), never a second copy of
//   it: the number the dialer refuses is the number the lead page locks. A
//   number on the list can't be changed or removed, and a contact or lead
//   holding one can't be deleted (the lead page's form, PUT /api/leads/[id],
//   the contacts API, DELETE /api/leads/[id]). The "texts blocked" flag still
//   locks too.
// - A number added to a lead that has a number on the list goes on the list
//   too, with that entry's reason, in the same transaction as the add (the lead
//   edit, a new contact, an upload merging into the lead), so a new number
//   can't route around the opt-out. Only numbers new to the lead: a number
//   already on it isn't touched here.
//
// This writes to the CRM's own list only. It never contacts anyone, and it
// never removes an entry. Emails: the CRM has no email opt-out list (nothing
// sets ContactEmail.isUnsubscribed), so emails are left as PR 5 made them.

/** `addedBy` on an entry added here, by the way the number came in. (Settings → Do not contact writes 'settings-do-not-contact'; SMS STOP 'sms-inbound-handler'.) */
export const SAME_LEAD_ADDED_BY = {
  leadEdit: 'same-lead-opt-out:lead-edit',
  newContact: 'same-lead-opt-out:contacts-api',
  upload: 'same-lead-opt-out:import',
} as const

/** The opt-out table: the app's client or a transaction's. */
export type OptOutDb = Pick<Prisma.TransactionClient, 'dncSuppression'>

const matcherDb = (db: OptOutDb) => db as unknown as InternalDncDb

/** The phones (as given) that are on the organization's Do not contact list, by the call checks' matcher. */
export async function phonesOnDoNotContact(db: OptOutDb, organizationId: string, phones: string[]): Promise<Set<string>> {
  if (phones.length === 0) return new Set()
  const hits = await internalDncHits(organizationId, phones, matcherDb(db))
  return new Set(phones.filter((p) => hits.has(normalizeE164(p))))
}

/** Numbers to put on the list, and the reason they get. */
export interface OptOutFollow {
  /** Canonical (+1 and 10 digits for a US number), in the order they were added. */
  phones: string[]
  /** The reason on the lead's earliest entry, as it is (null when it has none). */
  reason: string | null
}

/**
 * What a write that adds `adding` to a lead whose numbers are `existing` must
 * put on the Do not contact list: null when the lead (with the new numbers)
 * holds no number on the list, or every new number is already on it. One
 * lookup when nothing is listed; a second only to read the reason.
 */
export async function numbersToPutOnDoNotContact(
  db: OptOutDb,
  organizationId: string,
  lead: { existing: string[]; adding: string[] },
): Promise<OptOutFollow | null> {
  const onLead = new Set(lead.existing.map(normalizeE164))
  const fresh: string[] = []
  const seen = new Set<string>()
  for (const p of lead.adding) {
    const key = normalizeE164(p)
    if (onLead.has(key) || seen.has(key)) continue
    seen.add(key)
    fresh.push(p)
  }
  if (fresh.length === 0) return null

  // A save that brings a listed number and another one counts too: the same
  // number added in two saves would have been covered.
  const all = [...lead.existing, ...fresh]
  const hits = await internalDncHits(organizationId, all, matcherDb(db))
  const listed = all.filter((p) => hits.has(normalizeE164(p)))
  if (listed.length === 0) return null
  const phones = fresh
    .filter((p) => !hits.has(normalizeE164(p)))
    .map((p) => toE164(p))
    .filter((p): p is string => p !== null)
  if (phones.length === 0) return null

  const first = await db.dncSuppression.findFirst({
    where: { organizationId, source: 'internal', phone: { in: [...new Set(listed.flatMap(storedForms))] } },
    orderBy: [{ addedAt: 'asc' }, { id: 'asc' }],
    select: { reason: true },
  })
  return { phones: [...new Set(phones)], reason: first?.reason ?? null }
}

/**
 * Writes the entries, the same shape Settings → Do not contact writes
 * (addInternalDnc: the organization, the canonical number, source 'internal',
 * addedBy, the reason). Run inside the transaction that adds the numbers. An
 * insert that skips a number someone listed meanwhile, rather than
 * addInternalDnc's read-then-create, whose unique-key race would abort the
 * whole transaction on Postgres.
 */
export async function putOnDoNotContact(db: OptOutDb, organizationId: string, follow: OptOutFollow, addedBy: string): Promise<void> {
  await db.dncSuppression.createMany({
    data: follow.phones.map((phone) => ({ organizationId, phone, source: 'internal', addedBy, reason: follow.reason })),
    skipDuplicates: true,
  })
}

/** The first of these phones that's locked (on the list, then "texts blocked"), with its label; null when none is. */
export async function lockedPhone(
  db: OptOutDb,
  organizationId: string,
  phones: { phone: string; outboundSmsBlocked: boolean }[],
): Promise<{ phone: string; label: string } | null> {
  const listed = await phonesOnDoNotContact(db, organizationId, phones.map((p) => p.phone))
  const onList = phones.find((p) => listed.has(p.phone))
  if (onList) return { phone: onList.phone, label: DO_NOT_CONTACT_LABEL }
  const blocked = phones.find((p) => p.outboundSmsBlocked)
  return blocked ? { phone: blocked.phone, label: TEXTS_BLOCKED_LABEL } : null
}

/** Why a locked number stays, in plain words with its last 4 digits only; `then` ends the sentence. */
export function lockedMessage(locked: { phone: string; label: string }, then: string): string {
  const ending = `The number ending ${phoneLast4(locked.phone) ?? '…'}`
  return locked.label === DO_NOT_CONTACT_LABEL
    ? `${ending} is on the Do not contact list, so ${then}`
    : `${ending} has texts blocked (an opt-out), so ${then}`
}
