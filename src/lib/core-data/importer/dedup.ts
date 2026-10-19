import { findPhoneNumbersInText } from 'libphonenumber-js'
import { toValidE164 } from '@/lib/shared/phone'

// ─────────────────────────────────────────────────────────────────────────────
// Import dedup + normalization helpers (brief §9 Milestone 6).
//  - phone → E.164 via libphonenumber-js (US default);
//  - phone type → canonical {office, mobile, home, direct}, with nonstandard
//    values kept lowercased and flagged for Ryan's errorLog;
//  - dedup key: E.164 phone within an org; fallback to name + address.
// Pure — no DB, no I/O. Unit-tested to the 85% floor.
// ─────────────────────────────────────────────────────────────────────────────

export type CanonicalPhoneType = 'office' | 'mobile' | 'home' | 'direct'

const PHONE_TYPE_SYNONYMS: Record<string, CanonicalPhoneType> = {
  cell: 'mobile',
  cellular: 'mobile',
  mob: 'mobile',
  'mobile phone': 'mobile',
  mobile: 'mobile',
  work: 'office',
  'office phone': 'office',
  business: 'office',
  office: 'office',
  'home phone': 'home',
  residential: 'home',
  home: 'home',
  'direct dial': 'direct',
  dd: 'direct',
  direct: 'direct',
}

export interface NormalizedPhoneType {
  type: string
  nonstandard: boolean
}

// Maps a free-form incoming phone-type label to the canonical set; anything
// unrecognized is lowercased, kept as-is, and flagged nonstandard.
export function normalizePhoneType(raw: string | null | undefined): NormalizedPhoneType {
  if (!raw) return { type: 'mobile', nonstandard: false }
  const key = raw.trim().toLowerCase()
  const canonical = PHONE_TYPE_SYNONYMS[key]
  if (canonical) return { type: canonical, nonstandard: false }
  return { type: key, nonstandard: true }
}

// Normalizes a raw phone string to E.164 (US default). Returns null if the value
// cannot be parsed as a valid number — the caller drops it rather than fabricate.
// Brief 50 PR 13: the shared parser's reading, so an imported phone, its
// duplicate key and an opt-out are the same string ("+917 555 0147" is US).
export function normalizePhoneE164(raw: string | null | undefined): string | null {
  return toValidE164(raw) // E.164, e.g. +12125550134
}

// Brief 50 PR 6 (audit L6): every valid number in one cell, in the order
// written. A cell that is one valid number reads exactly as normalizePhoneE164.
// A cell holding two ("212-555-0101 / 917-555-0102", "…; …", "… or …", one per
// line, or just a space between them) wasn't a valid number as a whole, so
// both were dropped; now each is kept. Anything that isn't a number is still
// dropped. The first number stays first: it is the one a row is matched on.
const CELL_SEPARATORS = /[/;,|&\r\n]|\bor\b|\band\b/i

export function phonesInCell(raw: string | null | undefined): string[] {
  const whole = normalizePhoneE164(raw)
  if (whole) return [whole]
  const out: string[] = []
  for (const part of String(raw ?? '').split(CELL_SEPARATORS)) {
    const one = normalizePhoneE164(part)
    // Each number found is read again with the shared parser (PR 13's "+"
    // rule), so a number in a two-number cell is stored as it would be alone.
    const found = one
      ? [one]
      : findPhoneNumbersInText(part, 'US').flatMap((m) => {
          const e164 = m.number.isValid() ? toValidE164(part.slice(m.startsAt, m.endsAt)) : null
          return e164 ? [e164] : []
        })
    for (const e164 of found) if (!out.includes(e164)) out.push(e164)
  }
  return out
}

// Deterministic dedup key for a row within an org: prefer the E.164 phone;
// fall back to a normalized name + address composite when no phone is present.
export function dedupKey(input: {
  phoneE164?: string | null
  name?: string | null
  addressFull?: string | null
}): { kind: 'phone' | 'name-address' | 'none'; key: string | null } {
  if (input.phoneE164) return { kind: 'phone', key: `phone:${input.phoneE164}` }
  const name = (input.name ?? '').trim().toLowerCase()
  const addr = (input.addressFull ?? '').trim().toLowerCase()
  if (name || addr) return { kind: 'name-address', key: `na:${name}|${addr}` }
  return { kind: 'none', key: null }
}
