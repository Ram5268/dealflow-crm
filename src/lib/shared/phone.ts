import { parsePhoneNumberFromString, type PhoneNumber } from 'libphonenumber-js'

// Brief 50 PR 13 (open item 6.9): a "+" typed before a US number's 10 digits
// ("+917 555 0147"). libphonenumber reads the digits after a "+" as a country
// code ("+91…" is India, "+646…" New Zealand, "+212…" Morocco), so the number
// was stored foreign, or refused, and an opt-out or a duplicate check could
// miss it. When the "+" is followed by exactly 10 digits that are a valid
// US/NANP number (an assigned area code, area code and exchange not starting
// with 0 or 1), it is read as US: +1 and those 10 digits [engineering
// precaution: the CRM's leads are New York homeowners]. That wins over a
// foreign reading that is also valid (common NYC codes 646, 929, 516 and 201
// are valid foreign numbers that way). A number already starting "+1", and any
// other digit count (+44 20…, +91 and a full 10-digit number), reads as before.
const NANP_TEN_DIGITS = /^[2-9]\d{2}[2-9]\d{6}$/

function usNumberAfterStrayPlus(text: string): PhoneNumber | undefined {
  const start = text.search(/[+\d]/)
  if (start < 0 || text[start] !== '+') return undefined
  const us = parsePhoneNumberFromString(`${text.slice(0, start)}+1${text.slice(start + 1)}`, 'US')
  return us && us.countryCallingCode === '1' && NANP_TEN_DIGITS.test(us.nationalNumber) && us.isValid() ? us : undefined
}

// The one reading of a typed phone: libphonenumber's (US by default), with the
// stray-"+" rule above. The rule is also tried on the foreign reading's own
// E.164: libphonenumber drops a national "0" typed after the country code
// ("+64 (0)6 555 0123" → +6465550123), and that stored form, read again, is
// "+" and 10 digits. So the same digits typed with or without the "0" give one
// canonical string, and a canonical string reads back as itself (DS-1 leaves
// toE164(x) === x alone) [engineering precaution].
function readPhone(raw: string | null | undefined): PhoneNumber | undefined {
  const text = String(raw ?? '').trim()
  if (!text) return undefined
  const parsed = parsePhoneNumberFromString(text, 'US')
  if (parsed?.countryCallingCode === '1') return parsed
  return usNumberAfterStrayPlus(text) ?? (parsed && usNumberAfterStrayPlus(parsed.number)) ?? parsed
}

// Brief 41 (H13): the one form a phone is stored and matched in: E.164
// (+19175550147), US by default, the same parse the importer uses
// (importer/dedup.ts). It accepts any number of a possible length, so an
// opt-out is never refused for an unusual number. null = not a phone number.
export function toE164(raw: string | null | undefined): string | null {
  const parsed = readPhone(raw)
  return parsed && parsed.isPossible() ? parsed.number : null
}

// The importer's stricter form of the same reading: only a valid number (an
// import drops anything else rather than store a guess). Same canonical
// string as toE164 whenever both give one.
export function toValidE164(raw: string | null | undefined): string | null {
  const parsed = readPhone(raw)
  return parsed && parsed.isValid() ? parsed.number : null
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
