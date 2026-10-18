// Brief 44 (PR 5): DealFlow's own estimate of a seller's home and the public
// facts behind it: the seller's newest PUBLISHED PropertyValuation (PROPERTY_SQL
// in sync.ts), stored on the seller's signal as dealflowRawJson.property and
// shown only on Ryan's lead page. Our value estimates stay out of anything a
// buyer or homeowner could see (Ryan's decision, 2026-10-17); this card is his
// own screen.
//
// toPropertyFacts is a strict whitelist (engineering precaution): only the
// fields of Brief 44's valuation contract (§3, §7) pass, the shapes DealFlow's
// import already enforces (DealFlow lib/valuations/contract.ts). Numbers must
// be finite and in range, dates must be real ISO dates, the few strings
// are codes checked against a pattern, lists are capped, and everything else
// is dropped. A key that looks like a person's detail is never kept, even if
// it is added to a whitelist by mistake.

export const NO_VALUE_REASONS = ['five_plus_units', 'condo_without_unit', 'not_found', 'other_property_type'] as const
export type NoValueReason = (typeof NO_VALUE_REASONS)[number]

type LeadVsCity = { lead: number; city: number }

export interface PropertyFacts {
  units: number | null // residential units, per the city (PLUTO)
  buildingSqft: number | null
  lotSqft: number | null
  yearBuilt: number | null
  floors: number | null
  zoning: string | null
  buildingClass: string | null // DOF building class, e.g. "B1"
  historicDistrict: boolean | null
  lastSale: { date: string; price: number } | null // the last arm's-length sale
  dofMarketValue: { value: number; fiscalYear: number } | null // the city's market value
  permits7y: { count: number; major: boolean } | null // DOB alteration permits, last 7 years
  openViolations: { dob: number; ecb: number; hpd: number } | null
  subwayMiles: number | null // to the nearest subway station
  leadVsCity: { units: LeadVsCity | null; buildingSqft: LeadVsCity | null } | null // only where they disagree
}

// A nearby earlier sale: a public sales record. Ryan said yes (2026-10-17) to
// showing these addresses on his card.
export interface PropertyComp {
  address: string
  date: string
  price: number
  pricePerSqft: number
  distanceMiles: number
}

// Which public data the run used (the card's sources footer).
export interface PropertySources {
  downloadedOn: string | null
  salesThrough: string | null
  plutoVersion: string | null
  rollFiscalYear: number | null
  datasets: Record<string, { updatedOn: string | null; rows: number }>
}

export interface DealflowProperty {
  asOf: string // the value is as of this day
  dataThrough: string | null // the last city sale date the model saw
  publishedAt: string | null
  value: number | null // null, with a reason, when the model can't value the home
  low: number | null // the range is sized to hold the sale price about 2 times in 3
  high: number | null
  reason: NoValueReason | null
  facts: PropertyFacts | null
  comps: PropertyComp[] // only with a value; DealFlow's order
  sources: PropertySources | null
}

export const MAX_COMPS = 8 // as many as DealFlow stores
const MAX_DATASETS = 30

// Never kept, at any level, whatever a whitelist says (engineering precaution,
// Brief 44 contract §7). Owner names in particular: PLUTO owner names stay
// erased (Ryan's decision, 2026-10-17).
export const PERSONAL_KEY = /name|owner|part(?:y|ies)|phone|mail|contact|person|people|grantor|grantee/i

type Fields = Record<string, (v: unknown) => unknown>
type Picked<F extends Fields> = { [K in keyof F]: ReturnType<F[K]> }

const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)

// Only the listed keys, each through its parser (a missing key reads as
// undefined), and never one that looks like a person's detail.
export function whitelist<F extends Fields>(raw: unknown, fields: F): Picked<F> | null {
  if (!isObject(raw)) return null
  const out: Record<string, unknown> = {}
  for (const [key, parse] of Object.entries(fields)) {
    if (PERSONAL_KEY.test(key)) continue
    out[key] = parse(Object.hasOwn(raw, key) ? raw[key] : undefined)
  }
  return out as Picked<F>
}

// A small record that only means something whole (a sale is a date and a price).
const whole =
  <F extends Fields>(fields: F) =>
  (v: unknown) => {
    const o = whitelist(v, fields)
    return o && Object.values(o).every((x) => x !== null) ? (o as { [K in keyof F]: NonNullable<ReturnType<F[K]>> }) : null
  }

const num = (min: number, max: number) => (v: unknown) =>
  typeof v === 'number' && Number.isFinite(v) && v >= min && v <= max ? v : null
const int = (min: number, max: number) => (v: unknown) => (Number.isInteger(v) ? num(min, max)(v) : null)
const above0 = (max: number) => (v: unknown) => (typeof v === 'number' && v > 0 ? num(0, max)(v) : null)
const bool = (v: unknown) => (typeof v === 'boolean' ? v : null)
// Codes only (zoning "M1-2/R6A", building class "B1"), never free text.
const code = (pattern: RegExp) => (v: unknown) => (typeof v === 'string' && v.length <= 80 && pattern.test(v) ? v : null)

// A real calendar day, "2026-10-01" (how Postgres writes a date into JSON).
function isoDate(v: unknown): string | null {
  if (typeof v !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(v)) return null
  const d = new Date(`${v}T00:00:00Z`)
  if (Number.isNaN(d.getTime())) return null
  const year = d.getUTCFullYear()
  return d.toISOString().slice(0, 10) === v && year >= 1900 && year <= 2100 ? v : null
}

// A moment with its offset ("2026-10-20T10:31:00.123Z"), kept as UTC.
function isoTime(v: unknown): string | null {
  if (typeof v !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z|[+-]\d{2}:\d{2})$/.test(v)) return null
  const t = Date.parse(v)
  return isoDate(v.slice(0, 10)) && !Number.isNaN(t) ? new Date(t).toISOString() : null
}

const count = int(0, 1_000_000)
const sqft = above0(10_000_000)
const dollars = above0(1_000_000_000) // the cap DealFlow's import uses

const FACT_FIELDS = {
  units: count,
  buildingSqft: sqft,
  lotSqft: sqft,
  yearBuilt: int(1700, 2100),
  floors: num(0, 200),
  zoning: code(/^[A-Z0-9\/.-]{1,16}$/),
  buildingClass: code(/^[A-Z][0-9A-Z]$/),
  historicDistrict: bool,
  lastSale: whole({ date: isoDate, price: dollars }),
  dofMarketValue: whole({ value: dollars, fiscalYear: int(2000, 2100) }),
  permits7y: whole({ count, major: bool }),
  openViolations: whole({ dob: count, ecb: count, hpd: count }),
  subwayMiles: num(0, 25),
  leadVsCity: (v: unknown) =>
    whitelist(v, { units: whole({ lead: count, city: count }), buildingSqft: whole({ lead: sqft, city: sqft }) }),
}

const COMP_FIELDS = {
  // Starts with a house number, so free text can't pass for an address.
  address: code(/^[0-9]+(-[0-9]+)?[A-Z]? [A-Za-z0-9 #&'().,\/-]{2,72}$/),
  date: isoDate,
  price: dollars,
  pricePerSqft: above0(50_000),
  distanceMiles: num(0, 1.5),
}

// An NYC Open Data dataset id ("abcd-1234"), or the DOF annual sales files.
const DATASET_ID = /^(?:[a-z0-9]{4}-[a-z0-9]{4}|dof_annual)$/

function datasets(v: unknown): PropertySources['datasets'] {
  const out: PropertySources['datasets'] = {}
  if (!isObject(v)) return out
  for (const [id, d] of Object.entries(v).slice(0, MAX_DATASETS)) {
    const entry = whitelist(d, { updatedOn: isoDate, rows: int(0, 1_000_000_000) })
    if (DATASET_ID.test(id) && !PERSONAL_KEY.test(id) && entry && entry.rows !== null) {
      out[id] = { updatedOn: entry.updatedOn, rows: entry.rows }
    }
  }
  return out
}

const SOURCE_FIELDS = {
  downloadedOn: isoDate, // when the public files were downloaded
  salesThrough: isoDate, // the last city sale date in them
  plutoVersion: code(/^[0-9]{2}v[0-9](\.[0-9])?$/), // "26v2"
  rollFiscalYear: int(2020, 2100), // the DOF roll behind the market-value fact
  datasets,
}

const PROPERTY_FIELDS = {
  asOf: isoDate,
  dataThrough: isoDate,
  publishedAt: isoTime,
  value: dollars,
  low: dollars,
  high: dollars,
  reason: (v: unknown) => NO_VALUE_REASONS.find((r) => r === v) ?? null,
  facts: (v: unknown) => whitelist(v, FACT_FIELDS),
  comps: (v: unknown) =>
    Array.isArray(v)
      ? v.slice(0, MAX_COMPS).map(whole(COMP_FIELDS)).filter((c): c is PropertyComp => c !== null)
      : [],
  sources: (v: unknown) => whitelist(v, SOURCE_FIELDS),
}

// DealFlow's valuation row (PROPERTY_SQL) → dealflowRawJson.property, or null
// when there is none (no published run yet) or it isn't one.
export function toPropertyFacts(raw: unknown): DealflowProperty | null {
  const p = whitelist(raw, PROPERTY_FIELDS)
  const asOf = p?.asOf
  if (!p || !asOf) return null
  // One value inside a sane range, or no value at all: low ≤ value ≤ high,
  // low ≥ half the value, high ≤ twice it (contract §3, an engineering
  // precaution DealFlow's import enforces; checked again here).
  const { value, low, high } = p
  const valued =
    value !== null && low !== null && high !== null && low <= value && value <= high && low >= 0.5 * value && high <= 2 * value
  // Sales are earlier than the as-of date (contract §3, likewise checked again).
  const facts = p.facts && { ...p.facts, lastSale: p.facts.lastSale && p.facts.lastSale.date < asOf ? p.facts.lastSale : null }
  return {
    ...p,
    asOf,
    value: valued ? value : null,
    low: valued ? low : null,
    high: valued ? high : null,
    reason: valued ? null : p.reason,
    facts,
    comps: valued ? p.comps.filter((c) => c.date < asOf) : [], // nearby sales come only with a value
  }
}

// ── Display: the "Property value and facts" card ────────────────────────────

const DAY = new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' })

// "Oct 1, 2026"
export const dayText = (isoDay: string) => DAY.format(new Date(`${isoDay}T00:00:00Z`))

// "$1.83M", "$875k"
export function compactMoney(n: number): string {
  if (n < 1000) return `$${Math.round(n)}`
  const k = Math.round(n / 1000)
  return k < 1000 ? `$${k}k` : `$${Number((n / 1e6).toFixed(2))}M`
}

const sqftText = (n: number) => `${Math.round(n).toLocaleString('en-US')} sq ft`
const milesText = (n: number) => (n < 0.05 ? 'under 0.1 mi' : `${n.toFixed(1)} mi`)

// "$1.83M — likely $1.54M–$2.12M"; null without a value.
export function valueLine(p: DealflowProperty): string | null {
  if (p.value === null || p.low === null || p.high === null) return null
  return `${compactMoney(p.value)} — likely ${compactMoney(p.low)}–${compactMoney(p.high)}`
}

const NO_VALUE_WHY: Record<NoValueReason, string> = {
  five_plus_units: "5+ unit building: the city values these on income, so there's no model value.",
  condo_without_unit: "Condo building, but this lead has no unit number, so the unit can't be valued.",
  not_found: "We couldn't match this address to a city tax lot.",
  other_property_type: "Not a 1–4 family home (for example a garage, store or mixed-use lot), so there's no model value.",
}

// Why there's no value, in one sentence.
export function noValueText(reason: NoValueReason | null): string {
  return reason ? NO_VALUE_WHY[reason] : "There's no model value for this home."
}

// "Sep 12, 2026 · $1.75M · $712/sq ft · 0.1 mi"
export function compText(c: PropertyComp): string {
  const perSqft = `$${Math.round(c.pricePerSqft).toLocaleString('en-US')}/sq ft`
  return [dayText(c.date), compactMoney(c.price), perSqft, milesText(c.distanceMiles)].join(' · ')
}

// DOB alteration permits in the last 7 years: "2 alteration permits (major)".
function permitsText({ count, major }: { count: number; major: boolean }): string {
  if (count === 0) return 'No alteration permits'
  return `${count} alteration permit${count === 1 ? '' : 's'}${major ? ' (major)' : ''}`
}

// "Units: lead says 3, city says 2", only where the two disagree.
function disagreement(what: string, d: LeadVsCity | null | undefined, fmt: (n: number) => string): string | null {
  return d && d.lead !== d.city ? `${what}: lead says ${fmt(d.lead)}, city says ${fmt(d.city)}` : null
}

// The facts as label/value rows, in the card's order. A fact the city doesn't
// have is left out rather than shown blank.
export function factRows(f: PropertyFacts | null): { label: string; value: string }[] {
  if (!f) return []
  const v = f.openViolations
  const permits = f.permits7y
  const rows: [string, string | null][] = [
    ['Units', f.units === null ? null : String(f.units)],
    ['Building size', f.buildingSqft === null ? null : sqftText(f.buildingSqft)],
    ['Lot size', f.lotSqft === null ? null : sqftText(f.lotSqft)],
    ['Year built', f.yearBuilt === null ? null : String(f.yearBuilt)],
    ['Floors', f.floors === null ? null : String(Number(f.floors.toFixed(2)))],
    ['Zoning', f.zoning],
    ['Building class', f.buildingClass],
    ['Historic district', f.historicDistrict === null ? null : f.historicDistrict ? 'Yes' : 'No'],
    ['Last sale', f.lastSale && `${compactMoney(f.lastSale.price)} · ${dayText(f.lastSale.date)}`],
    ['City market value', f.dofMarketValue && `${compactMoney(f.dofMarketValue.value)} (FY${f.dofMarketValue.fiscalYear})`],
    ['Permits (7 yrs)', permits && permitsText(permits)],
    ['Open violations', v && (v.dob + v.ecb + v.hpd === 0 ? 'None' : `DOB ${v.dob} · ECB ${v.ecb} · HPD ${v.hpd}`)],
    ['Nearest subway', f.subwayMiles === null ? null : milesText(f.subwayMiles)],
    ['Lead vs city', disagreement('Units', f.leadVsCity?.units, String)],
    ['Lead vs city', disagreement('Building size', f.leadVsCity?.buildingSqft, sqftText)],
  ]
  return rows.filter((r): r is [string, string] => r[1] !== null).map(([label, value]) => ({ label, value }))
}

// "Sources: PLUTO 26v2 · DOF FY2027 roll · city sales through Sep 30, 2026 ·
// public records downloaded Oct 18, 2026"; null when the run named none.
export function sourcesText(p: DealflowProperty): string | null {
  const s = p.sources
  const salesThrough = s?.salesThrough ?? p.dataThrough
  const parts = [
    s?.plutoVersion ? `PLUTO ${s.plutoVersion}` : null,
    s?.rollFiscalYear ? `DOF FY${s.rollFiscalYear} roll` : null,
    salesThrough ? `city sales through ${dayText(salesThrough)}` : null,
    s?.downloadedOn ? `public records downloaded ${dayText(s.downloadedOn)}` : null,
  ].filter((x): x is string => x !== null)
  return parts.length > 0 ? `Sources: ${parts.join(' · ')}` : null
}
