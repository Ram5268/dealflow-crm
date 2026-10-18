import { parsePhoneNumberFromString } from 'libphonenumber-js'

// Brief 41 (H13): the one form a phone is stored and matched in: E.164
// (+19175550147), US by default, the same parse the importer uses
// (importer/dedup.ts). It accepts any number of a possible length, so an
// opt-out is never refused for an unusual number. null = not a phone number.
export function toE164(raw: string | null | undefined): string | null {
  const text = (raw ?? '').trim()
  if (!text) return null
  const parsed = parsePhoneNumberFromString(text, 'US')
  return parsed && parsed.isPossible() ? parsed.number : null
}

// A list of phones in canonical form (the same number typed twice is kept
// once: a contact's phones are unique), or the first value that isn't a phone
// number (the contacts API answers 400 with it).
export function canonicalPhones<T extends { phone: string }>(
  phones: T[],
): { ok: true; phones: T[] } | { ok: false; invalid: string } {
  const out: T[] = []
  for (const p of phones) {
    const phone = toE164(p.phone)
    if (!phone) return { ok: false, invalid: p.phone }
    if (!out.some((q) => q.phone === phone)) out.push({ ...p, phone })
  }
  return { ok: true, phones: out }
}
