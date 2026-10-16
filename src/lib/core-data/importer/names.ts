// Brief 41.1 (F10): when a phone match is a different person.
//
// A merge import matched a row to a lead by phone even when the names said
// otherwise, so "Bob Owner" could fill "Alice Owner"'s blank address and Mojo
// ID. A phone match where both sides have real names, and none of them agree,
// is now a different person: the row becomes its own lead.
//
// What counts as a name follows how the import builds displayName (Lead.name,
// then Contact.name, then the address, then the Mojo ID, then "Imported
// Lead"): only the first two are names. A displayName that is the address, the
// Mojo ID or the "Imported Lead" placeholder is not.

import { streetIdentity } from './address'

export const PLACEHOLDER_NAME = 'Imported Lead'

// Titles, suffixes and joining words that never tell two people apart.
const IGNORED = new Set(['mr', 'mrs', 'ms', 'miss', 'mx', 'dr', 'jr', 'sr', 'ii', 'iii', 'iv', 'esq', 'and', 'the'])

// "SMITH, Robert J." → ['smith', 'robert']: lowercase, no accents or
// punctuation, no initials, titles or suffixes.
export function nameWords(raw: string | null | undefined): string[] {
  return (raw ?? '')
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
    .split(' ')
    .filter((w) => w.length > 1 && !IGNORED.has(w))
}

const sameWords = (a: string | null | undefined, b: string | null | undefined) => {
  const x = nameWords(a)
  const y = nameWords(b)
  return x.length > 0 && x.length === y.length && x.every((w, i) => w === y[i])
}

// A real person's or company's name, not a stand-in for one.
export function isRealName(
  name: string | null | undefined,
  context: { address?: string | null; mojoId?: string | null } = {}
): boolean {
  const words = nameWords(name)
  if (words.length === 0 || words.every((w) => /^\d+$/.test(w))) return false
  if (sameWords(name, PLACEHOLDER_NAME)) return false
  const address = context.address ?? null
  if (address && (sameWords(name, address) || sameWords(name, address.split(',')[0]))) return false
  // An address used as the name (a lead whose address was later rewritten
  // keeps the old one as its displayName): a house number and a street type.
  // "1st Choice Realty" and "Park Place Realty" are names.
  const asAddress = streetIdentity(name)
  if (asAddress?.house && asAddress.type) return false
  if (context.mojoId && sameWords(name, context.mojoId)) return false
  return true
}

// Two spellings of one name: one's words all appear in the other's, so a
// middle initial, word order, "Estate of" or a co-owner's "&" never splits a
// person ("Alice Owner" = "OWNER, Alice Q." = "Alice & Bob Owner").
export function sameName(a: string, b: string): boolean {
  const x = new Set(nameWords(a))
  const y = new Set(nameWords(b))
  if (x.size === 0 || y.size === 0) return false
  const [small, big] = x.size <= y.size ? [x, y] : [y, x]
  for (const w of small) if (!big.has(w)) return false
  return true
}

// Both sides have real names and none of them agree: a different person.
// Either side with no real name (a phone-only row, an "Imported Lead") never
// conflicts.
export function namesConflict(rowNames: string[], leadNames: string[]): boolean {
  if (rowNames.length === 0 || leadNames.length === 0) return false
  return !rowNames.some((r) => leadNames.some((l) => sameName(r, l)))
}

// Every real name a lead carries: its owner name, a hand-typed displayName,
// and its contacts' names (a co-owner).
export function leadRealNames(lead: {
  name: string | null
  displayName: string
  primaryAddressFull: string | null
  mojoId: string | null
  contacts?: Array<{ name: string | null; displayName: string }>
}): string[] {
  const context = { address: lead.primaryAddressFull, mojoId: lead.mojoId }
  const candidates = [lead.name, lead.displayName, ...(lead.contacts ?? []).flatMap((c) => [c.name, c.displayName])]
  const out: string[] = []
  for (const n of candidates) if (n && isRealName(n, context) && !out.includes(n)) out.push(n)
  return out
}
