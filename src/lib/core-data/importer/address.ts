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
// name + street type + any suffix word after the type + unit (+ ZIP).

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
// Extension", "Plaza St East"). Anything else after the type is the unit or
// the city.
const AFTER_TYPE = new Set(['extension', 'north', 'south', 'east', 'west', 'northeast', 'northwest', 'southeast', 'southwest'])
// City, state and ZIP at the end of a one-cell address ("2 Pine St Brooklyn NY 11201").
const LOCALITY = new Set(['brooklyn', 'bklyn', 'queens', 'bronx', 'manhattan', 'staten', 'island', 'new', 'york', 'nyc', 'ny', 'nj', 'ct', 'usa'])
const DIRECTIONS = new Set(['north', 'south', 'east', 'west'])
// The word after N/S/E/W in a place name ("East Elmhurst", "East New York",
// "South Ozone Park", "West Brighton"): in a one-cell address, such a pair
// after the street is the town, not a suffix of the street.
const TOWN_AFTER_DIRECTION = new Set([
  'elmhurst', 'new', 'flatbush', 'williamsburg', 'harlem', 'village', 'tremont', 'rockaway', 'meadow', 'islip',
  'hampton', 'hamptons', 'northport', 'hills', 'setauket', 'norwich', 'quogue', 'moriches', 'patchogue',
  'massapequa', 'atlantic', 'side', 'end', 'brighton', 'farms', 'hempstead', 'babylon', 'sayville', 'nyack',
  'point', 'orange', 'ozone', 'richmond', 'jamaica', 'slope', 'beach', 'bronx', 'floral', 'huntington', 'river',
  'amboy', 'plainfield', 'riverdale', 'corona', 'baldwin', 'bellmore', 'merrick', 'woodmere', 'valley', 'bergen',
  'shore', 'brunswick', 'white', 'haven', 'rutherford', 'hanover', 'caldwell', 'harrison', 'haverstraw',
  'tarrytown', 'castle', 'salem', 'arlington', 'bay', 'neck',
])
// A unit written without a marker ("123 Main St Rear", "361 Degraw St PH").
const UNIT_WORDS: Record<string, string> = {
  ph: 'ph', penthouse: 'ph', rear: 'rear', front: 'front', bsmt: 'bsmt', basement: 'bsmt',
  garden: 'garden', gdn: 'garden', upper: 'upper', lower: 'lower',
}
const ZIP = /^\d{5}(\d{4})?$/
// "2nd Floor", "1st Fl" / "Fl 3", "Floor 3": a floor is its own kind of unit.
const FLOOR_BEFORE = /(?:^|\s)(\d+)\s*(?:st|nd|rd|th)?\s*(?:fl|flr|floor)\b\.?/
const FLOOR_AFTER = /(?:^|\s)(?:fl|flr|floor)\b\.?\s*(\d+)(?:st|nd|rd|th)?\b/
const UNIT = /(?:#|(?:^|\s)(?:apt|apartment|unit|ste|suite|rm|room|ph|penthouse)\b\.?)\s*([a-z0-9][a-z0-9-]*)?/

export interface StreetIdentity {
  house: string
  name: string
  type: string | null
  after: string
  unit: string | null
  zip: string | null
}

// "Apt 03-R" → "3r", "Penthouse" → "ph", "PH-1" → "ph1".
function unitKey(raw: string): string {
  const v = raw.toLowerCase().replace(/[^a-z0-9]/g, '').replace(/^0+(?=\d)/, '')
  return UNIT_WORDS[v] ?? v.replace(/^penthouse/, 'ph')
}

// A unit standing alone: "4B", "2F", "PH1", "Rear", or a single letter ("A").
// Not a ZIP. After a street type, N/S/E/W have already become direction
// words; as a comma part ("123 Main St, N") they aren't taken as a unit.
function bareUnit(token: string | undefined): string | null {
  if (!token) return null
  if (UNIT_WORDS[token]) return UNIT_WORDS[token]
  if (/^[a-z]$/.test(token) && !'nsew'.includes(token)) return token
  if (/\d/.test(token) && !ZIP.test(token) && token.length <= 6) return unitKey(token)
  return null
}

function unitOf(part: string): { unit: string | null; rest: string } {
  const floor = FLOOR_BEFORE.exec(part) ?? FLOOR_AFTER.exec(part)
  if (floor) return { unit: `fl${floor[1].replace(/^0+(?=\d)/, '')}`, rest: part.slice(0, floor.index) }
  const m = UNIT.exec(part)
  if (!m) return { unit: null, rest: part }
  const marker = m[0].trim().replace(/[#.]/g, '').split(/\s+/)[0]
  const value = m[1] ? unitKey(m[1]) : ''
  // "PH" / "Penthouse" is a marker and a unit ("PH", "PH 1"); "Apt"/"#" alone says nothing.
  const unit = marker === 'ph' || marker === 'penthouse' ? `ph${value === 'ph' ? '' : value}` : value
  return { unit: unit || null, rest: part.slice(0, m.index) }
}

// The ZIP at the end of an address (not a house number at its start).
function zipOf(address: string): string | null {
  const found = [...address.matchAll(/(?<![\d-])(\d{5})(?:-\d{4})?(?![\d-])/g)].filter((m) => (m.index ?? 0) > 0)
  return found.length ? found[found.length - 1][1] : null
}

// null when the address has no street name: such a line ("12", "Brooklyn, NY
// 11201") names no property, so it never matches. A street with no house
// number ("Main St") has house '' and matches only the same street with none.
export function streetIdentity(address: string | null | undefined): StreetIdentity | null {
  const raw = (address ?? '').toLowerCase().trim()
  const parts = raw.split(',').map((p) => p.trim())
  const first = unitOf(parts[0] ?? '')
  let unit = first.unit
  // "361 Degraw St, Apt 3, Brooklyn" / "123 Main St, 4B": the unit can be its own comma part.
  if (!unit && parts[1]) {
    const next = unitOf(parts[1])
    if (next.unit && next.rest.trim() === '') unit = next.unit
    else if (!next.unit && /^[a-z0-9-]+$/.test(parts[1])) unit = bareUnit(parts[1].replace(/-/g, ''))
  }
  const tokens = first.rest
    .replace(/(\d)-(\d)/g, '$1$2') // 18-14 → 1814
    .replace(/'/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim().split(' ').filter(Boolean)
    .map((t) => t.replace(/^(\d+)(st|nd|rd|th)$/, '$1')) // 54th → 54
  const house = /^\d+[a-z]?$/.test(tokens[0] ?? '') ? tokens[0] : ''
  let words = (house ? tokens.slice(1) : tokens).map((t, i) => (t === 'st' && i === 0 ? 'saint' : WORDS[t] ?? MORE_WORDS[t] ?? t))
  // A one-cell address carries the city, state and ZIP after the street
  // ("… Brooklyn NY 11201", "… East New York NY 11207").
  let cut = words.length
  while (cut > 1 && (LOCALITY.has(words[cut - 1]) || ZIP.test(words[cut - 1]))) cut--
  if (cut > 1 && cut < words.length && DIRECTIONS.has(words[cut - 1]) && TOWN_AFTER_DIRECTION.has(words[cut])) cut--
  words = words.slice(0, cut)
  if (words.length === 0 || words.every((w) => LOCALITY.has(w))) return null
  const zip = zipOf(raw)
  // The type is the first type word after at least one name word, so "Court
  // St" is Court + street and "Avenue J" (type first) is all name.
  const t = words.findIndex((w, i) => i > 0 && STREET_TYPES.has(w))
  if (t === -1) return house ? { house, name: words.join(' '), type: null, after: '', unit, zip } : null
  const rest = words.slice(t + 1)
  let k = 0
  const after: string[] = []
  // A direction word followed by a town word starts the town ("100 Main St
  // East Elmhurst NY"), it isn't the street's suffix ("1 Plaza St East").
  for (; k < rest.length && AFTER_TYPE.has(rest[k]); k++) {
    if (DIRECTIONS.has(rest[k]) && TOWN_AFTER_DIRECTION.has(rest[k + 1] ?? '')) break
    after.push(rest[k])
  }
  // A unit with no marker right after the street ("123 Main St 4B", "… PH 1").
  if (!unit) {
    unit = bareUnit(rest[k])
    if (unit === 'ph' && /^\d+$/.test(rest[k + 1] ?? '')) unit = `ph${rest[k + 1]}`
  }
  return { house, name: words.slice(0, t).join(' '), type: words[t], after: after.join(' '), unit, zip }
}

// Two addresses name the same property when the house number, street name,
// any suffix word ("Extension", "North"), the unit and the ZIP agree.
// Spelling is forgiven (St/Street, St/Saint, E/East, 18-14/1814, a one-cell
// address with the city after the street, "4B" = "Apt 4B"). A street type,
// unit or ZIP missing on one side is allowed ("2 Pine" = "2 Pine St";
// "361 Degraw St" = "361 Degraw St # 3"), but two different ones are not
// ("Pl" vs "St", "#3" vs "#4", "4B" vs "5A", "Rear" vs "Front", 11201 vs 11215).
export function sameStreet(a: string | null | undefined, b: string | null | undefined): boolean {
  const x = streetIdentity(a)
  const y = streetIdentity(b)
  if (!x || !y) return false
  if (x.house !== y.house || x.name !== y.name || x.after !== y.after) return false
  if (x.type && y.type && x.type !== y.type) return false
  if (x.unit && y.unit && x.unit !== y.unit) return false
  if (x.zip && y.zip && x.zip !== y.zip) return false
  return true
}
