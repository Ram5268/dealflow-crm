// Brief 41 (H4): street comparison for import matching, never for display.
// The same rules DealFlow's CRM sync uses to compare streets
// (dealflow lib/crm-sync/addressNormalize.ts): case, punctuation, unit suffixes
// ("# 3", "Apt 4"), ordinals, Queens hyphenated house numbers and the common
// street-word abbreviations.
const WORDS: Record<string, string> = {
  st: 'street', str: 'street', ave: 'avenue', av: 'avenue', pl: 'place', rd: 'road', dr: 'drive',
  blvd: 'boulevard', pkwy: 'parkway', ct: 'court', ln: 'lane', ter: 'terrace', hwy: 'highway',
  sq: 'square', ft: 'fort', mt: 'mount', n: 'north', s: 'south', e: 'east', w: 'west',
}

export function normalizeStreet(raw: string | null | undefined): string | null {
  const tokens = (raw ?? '').toLowerCase()
    .replace(/\s*(#|\b(apt|apartment|unit|ste|suite|fl|floor)\b).*$/, '') // unit suffix
    .replace(/(\d)-(\d)/g, '$1$2') // 18-14 → 1814
    .replace(/'/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim().split(' ').filter(Boolean)
    .map((t) => t.replace(/^(\d+)(st|nd|rd|th)$/, '$1')) // 54th → 54
  // "St" right after the house number means Saint (115 St Marks Ave).
  const words = tokens.map((t, i) => (t === 'st' && i === 1 && /^\d/.test(tokens[0]) ? 'saint' : WORDS[t] ?? t))
  return words.length ? words.join(' ') : null
}

// The street line of a full address ("361 Degraw St # 3, Brooklyn, NY" → normalized "361 degraw street").
export function streetOf(address: string | null | undefined): string | null {
  return normalizeStreet(address?.split(',')[0])
}

// Two addresses name the same property when their street lines normalize equal.
// A one-cell address with no comma ("2 Pine St Brooklyn NY 11201") carries the
// city after the street, so a street that starts with the other also counts.
export function sameStreet(a: string | null | undefined, b: string | null | undefined): boolean {
  const x = streetOf(a)
  const y = streetOf(b)
  if (!x || !y) return false
  return x === y || x.startsWith(y + ' ') || y.startsWith(x + ' ')
}
