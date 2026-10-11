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

// Used to group rows that may be the same owner (commit-worker
// groupRowsByIdentity). Keep it as it is: a stopped import resumes by group
// index, so the grouping of a file must not change between deploys.
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

// ─── Brief 41.1 (F10): which property an address names ──────────────────────
// sameStreet used to strip units and let either street line be a prefix of the
// other, so "#3" matched "#4", "12 Main St" matched "12 Main St Extension", and
// a stored line with no street name ("12", or just "Brooklyn") matched any
// street starting with it. An address is now read as house number + street
// name + street type + any suffix word after the type + unit.

// Words that end a street name ("Main St", "Court St", "Grand Army Plaza").
const STREET_TYPES = new Set([
  'street', 'avenue', 'place', 'road', 'drive', 'boulevard', 'parkway', 'court', 'lane', 'terrace',
  'highway', 'square', 'plaza', 'way', 'walk', 'circle', 'crescent', 'row', 'loop', 'alley',
  'expressway', 'turnpike', 'oval', 'path', 'concourse',
])
const MORE_WORDS: Record<string, string> = {
  plz: 'plaza', cir: 'circle', expy: 'expressway', tpke: 'turnpike', ext: 'extension',
  ne: 'northeast', nw: 'northwest', se: 'southeast', sw: 'southwest',
}
// Words after the type that are part of the street's name ("Flatbush Ave
// Extension", "Plaza St East"). Anything else after the type is the city.
const AFTER_TYPE = new Set(['extension', 'north', 'south', 'east', 'west', 'northeast', 'northwest', 'southeast', 'southwest'])
// City, state and ZIP at the end of a one-cell address ("2 Pine St Brooklyn NY 11201").
const LOCALITY = new Set(['brooklyn', 'queens', 'bronx', 'manhattan', 'staten', 'island', 'new', 'york', 'nyc', 'ny', 'nj', 'ct', 'usa'])
const UNIT = /(?:#|(?:^|\s)(?:apt|apartment|unit|ste|suite|fl|floor|rm|room)\b\.?)\s*([a-z0-9][a-z0-9-]*)?/

export interface StreetIdentity {
  house: string
  name: string
  type: string | null
  after: string
  unit: string | null
}

function unitOf(part: string): { unit: string | null; rest: string } {
  const m = UNIT.exec(part)
  if (!m) return { unit: null, rest: part }
  const unit = m[1] ? m[1].replace(/-/g, '').replace(/^0+(?=\d)/, '') : null
  return { unit: unit || null, rest: part.slice(0, m.index) }
}

// null when the address has no house number and street name: such a line
// ("12", "Brooklyn, NY 11201") names no property, so it never matches.
export function streetIdentity(address: string | null | undefined): StreetIdentity | null {
  const parts = (address ?? '').toLowerCase().split(',').map((p) => p.trim())
  const first = unitOf(parts[0] ?? '')
  let unit = first.unit
  // "361 Degraw St, Apt 3, Brooklyn": the unit can be its own comma part.
  if (!unit && parts[1]) {
    const next = unitOf(parts[1])
    if (next.unit && next.rest.trim() === '') unit = next.unit
  }
  const tokens = first.rest
    .replace(/(\d)-(\d)/g, '$1$2') // 18-14 → 1814
    .replace(/'/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim().split(' ').filter(Boolean)
    .map((t) => t.replace(/^(\d+)(st|nd|rd|th)$/, '$1')) // 54th → 54
  const house = tokens[0]
  if (!house || !/^\d+[a-z]?$/.test(house)) return null
  let words = tokens.slice(1).map((t, i) => (t === 'st' && i === 0 ? 'saint' : WORDS[t] ?? MORE_WORDS[t] ?? t))
  // A one-cell address carries the city, state and ZIP after the street.
  while (words.length > 1 && (LOCALITY.has(words[words.length - 1]) || /^\d{5}(\d{4})?$/.test(words[words.length - 1]))) {
    words = words.slice(0, -1)
  }
  if (words.length === 0 || words.every((w) => LOCALITY.has(w))) return null
  // The type is the first type word after at least one name word, so "Court
  // St" is Court + street and "Avenue J" (type first) is all name.
  const t = words.findIndex((w, i) => i > 0 && STREET_TYPES.has(w))
  if (t === -1) return { house, name: words.join(' '), type: null, after: '', unit }
  const after: string[] = []
  for (const w of words.slice(t + 1)) {
    if (!AFTER_TYPE.has(w)) break
    after.push(w)
  }
  return { house, name: words.slice(0, t).join(' '), type: words[t], after: after.join(' '), unit }
}

// Two addresses name the same property when the house number, street name,
// any suffix word ("Extension", "North") and the unit agree. Spelling is
// forgiven (St/Street, St/Saint, E/East, 18-14/1814, a one-cell address with
// the city after the street). A street type or unit missing on one side is
// allowed ("2 Pine" = "2 Pine St"; "361 Degraw St" = "361 Degraw St # 3"), but
// two different ones are not ("Pl" vs "St", "#3" vs "#4").
export function sameStreet(a: string | null | undefined, b: string | null | undefined): boolean {
  const x = streetIdentity(a)
  const y = streetIdentity(b)
  if (!x || !y) return false
  if (x.house !== y.house || x.name !== y.name || x.after !== y.after) return false
  if (x.type && y.type && x.type !== y.type) return false
  if (x.unit && y.unit && x.unit !== y.unit) return false
  return true
}
