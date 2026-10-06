import { toE164 } from '@/lib/shared/phone'

// Brief 41 (H13): the plan for rewriting phones stored before canonical E.164
// (the internal opt-out list and contact phones). Pure, so it is unit-tested;
// scripts/brief41-canonical-phones.ts reads the rows and applies it.
//
// - Rows already in canonical form are left alone.
// - A row is rewritten only when its number has no canonical row yet in its
//   group (an opt-out's org and source; a contact phone's contact: both tables
//   are unique on that group plus phone). The other formats of a number that
//   has one stay as they are (they still match, see storedForms). Nothing is
//   deleted.
// - A value that isn't a phone number is reported, never changed.

export interface StoredDncRow {
  id: string
  organizationId: string
  source: string
  phone: string
}

export interface StoredPhoneRow {
  id: string
  contactId: string
  phone: string
}

export interface PhoneBackfillPlan {
  dnc: { rewrite: Array<{ id: string; phone: string }>; alreadyCovered: string[]; unparseable: string[] }
  contactPhones: { rewrite: Array<{ id: string; phone: string }>; alreadyCovered: string[]; unparseable: string[] }
}

export function planPhoneBackfill(dncRows: StoredDncRow[], contactPhones: StoredPhoneRow[]): PhoneBackfillPlan {
  const plan: PhoneBackfillPlan = {
    dnc: { rewrite: [], alreadyCovered: [], unparseable: [] },
    contactPhones: { rewrite: [], alreadyCovered: [], unparseable: [] },
  }

  const groupKey = (r: StoredDncRow, canonical: string) => `${r.organizationId}\u0000${r.source}\u0000${canonical}`
  const covered = new Set<string>()
  for (const r of dncRows) {
    const canonical = toE164(r.phone)
    if (canonical && canonical === r.phone) covered.add(groupKey(r, canonical))
  }
  for (const r of dncRows) {
    const canonical = toE164(r.phone)
    if (!canonical) {
      plan.dnc.unparseable.push(r.id)
      continue
    }
    if (canonical === r.phone) continue
    const key = groupKey(r, canonical)
    if (covered.has(key)) {
      plan.dnc.alreadyCovered.push(r.id)
      continue
    }
    covered.add(key) // this row becomes the canonical one
    plan.dnc.rewrite.push({ id: r.id, phone: canonical })
  }

  const phoneKey = (r: StoredPhoneRow, canonical: string) => `${r.contactId}\u0000${canonical}`
  const contactCovered = new Set<string>()
  for (const r of contactPhones) {
    const canonical = toE164(r.phone)
    if (canonical && canonical === r.phone) contactCovered.add(phoneKey(r, canonical))
  }
  for (const r of contactPhones) {
    const canonical = toE164(r.phone)
    if (!canonical) {
      plan.contactPhones.unparseable.push(r.id)
      continue
    }
    if (canonical === r.phone) continue
    const key = phoneKey(r, canonical)
    if (contactCovered.has(key)) {
      plan.contactPhones.alreadyCovered.push(r.id)
      continue
    }
    contactCovered.add(key)
    plan.contactPhones.rewrite.push({ id: r.id, phone: canonical })
  }
  return plan
}
