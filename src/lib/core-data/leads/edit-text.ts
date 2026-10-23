// Brief 50 PR 5 — the lead timeline entry for an edit made on the lead page
// (item 6.5). One save that changes something writes ONE Activity of type
// 'Edit', no user, whose text lists each change on its own line in plain
// words ("Name changed", "Phone added (…0123)", "Status: New → Contacted").
// An edit is a note about the record, not contact with the lead.
//
// Pure (no database), so the timeline (a client component) reads the same
// constant and the wording is tested without a page.

export const LEAD_EDIT_ACTIVITY_TYPE = 'Edit'

// Only a phone's last 4 digits go into the entry [engineering precaution]: the
// entry outlives the number (a removed phone stays named in the history), and
// the last 4 are enough to tell numbers apart. Fewer than 7 digits (shorter
// than a local number) shows none, since 4 would be most of it — the same
// rule as the Do-not-contact screen (src/lib/settings/doNotContact.ts).
const MIN_DIGITS_TO_SHOW = 7

export function phoneLast4(stored: string | null | undefined): string | null {
  const digits = (stored ?? '').replace(/\D/g, '')
  return digits.length >= MIN_DIGITS_TO_SHOW ? digits.slice(-4) : null
}

const phoneTag = (stored: string) => {
  const last4 = phoneLast4(stored)
  return last4 ? `…${last4}` : null
}

export function phoneAdded(phone: string): string {
  const tag = phoneTag(phone)
  return tag ? `Phone added (${tag})` : 'Phone added'
}

export function phoneRemoved(phone: string): string {
  const tag = phoneTag(phone)
  return tag ? `Phone removed (${tag})` : 'Phone removed'
}

export function phoneChanged(from: string, to: string): string {
  const a = phoneTag(from)
  const b = phoneTag(to)
  return a && b ? `Phone changed (${a} → ${b})` : 'Phone changed'
}

// An email shows as its first letter and its domain ("t…@example.com"), for
// the same reason as a phone's last 4 digits [engineering precaution].
export function maskEmail(email: string): string {
  const at = email.lastIndexOf('@')
  if (at < 1) return '…'
  return `${email[0]}…${email.slice(at)}`
}

export const emailAdded = (email: string) => `Email added (${maskEmail(email)})`
export const emailRemoved = (email: string) => `Email removed (${maskEmail(email)})`
export const emailChanged = (from: string, to: string) => `Email changed (${maskEmail(from)} → ${maskEmail(to)})`

export const NAME_CHANGED = 'Name changed'

export function statusChange(from: string | null, to: string | null): string {
  if (from && to) return `Status: ${from} → ${to}`
  if (to) return `Status set to ${to}`
  return `Status cleared (was ${from ?? 'blank'})`
}

export function addressChange(from: string | null, to: string | null): string {
  if (from && to) return 'Address changed'
  return to ? 'Address added' : 'Address removed'
}

/** The changes in an entry, one per line. */
export function editEntryLines(bodyText: string | null | undefined): string[] {
  return (bodyText ?? '')
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
}
