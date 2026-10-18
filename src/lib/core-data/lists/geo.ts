// Brief 45 — borough, neighborhood and unit count for list and Pipeline
// filters, read from the Mojo custom fields "Property Zip Code", "Property
// City" and "Property Type" [CONTRACT §4]. Pure: sql.ts builds the same
// mapping in SQL from these tables, and a DB test proves they agree.
import type { Borough } from './types'

// ─── ZIP → borough ───────────────────────────────────────────────────────────
// USPS ZIP prefixes: 100–102 Manhattan, 103 Staten Island, 104 Bronx,
// 112 Brooklyn, 111/113/114/116 Queens; 110xx is Nassau County except the two
// Queens ZIPs 11004 (Glen Oaks) and 11005 (Floral Park, Queens).
export const ZIP5_BOROUGH: Record<string, Borough> = { '11004': 'Queens', '11005': 'Queens' }
export const ZIP3_BOROUGH: Record<string, Borough> = {
  '100': 'Manhattan', '101': 'Manhattan', '102': 'Manhattan',
  '103': 'Staten Island', '104': 'Bronx', '112': 'Brooklyn',
  '111': 'Queens', '113': 'Queens', '114': 'Queens', '116': 'Queens',
}

// ─── City → borough (when there's no usable ZIP) ─────────────────────────────
// Lowercase. Queens addresses use the neighborhood as the city (USPS), so the
// Queens list is the Queens postal city names. Names shared with Nassau County
// (Floral Park, New Hyde Park, Bellerose) are left out: no guessing.
export const CITY_BOROUGH: Record<Borough, readonly string[]> = {
  Manhattan: ['manhattan', 'new york', 'new york city', 'nyc'],
  Brooklyn: ['brooklyn'],
  Bronx: ['bronx', 'the bronx'],
  'Staten Island': ['staten island'],
  Queens: [
    'queens', 'astoria', 'long island city', 'flushing', 'jamaica', 'ridgewood', 'forest hills', 'rego park',
    'elmhurst', 'east elmhurst', 'jackson heights', 'corona', 'woodside', 'sunnyside', 'maspeth',
    'middle village', 'glendale', 'kew gardens', 'richmond hill', 'south richmond hill', 'ozone park',
    'south ozone park', 'howard beach', 'woodhaven', 'fresh meadows', 'bayside', 'oakland gardens',
    'little neck', 'douglaston', 'whitestone', 'college point', 'hollis', 'queens village', 'glen oaks',
    'saint albans', 'st albans', 'st. albans', 'springfield gardens', 'cambria heights', 'rosedale',
    'laurelton', 'far rockaway', 'arverne', 'rockaway park', 'rockaway beach', 'breezy point',
    'belle harbor', 'neponsit', 'jamaica estates', 'briarwood', 'auburndale', 'beechhurst',
    'broad channel', 'kew gardens hills',
  ],
}

const CITY_INDEX = new Map<string, Borough>(
  (Object.entries(CITY_BOROUGH) as [Borough, readonly string[]][]).flatMap(([b, names]) => names.map((n) => [n, b] as const)),
)

/** The 5-digit ZIP at the start of a value ("11215", "10013-1234"), else null. */
export function zip5(raw: string | null | undefined): string | null {
  return raw?.trim().match(/^([0-9]{5})(?:-[0-9]{4})?\b/)?.[1] ?? null
}

/** Lowercase, single-spaced, trimmed: how city names are compared. */
export function cityKey(raw: string | null | undefined): string {
  return (raw ?? '').replace(/\s+/g, ' ').trim().toLowerCase()
}

export function boroughOf(zipRaw: string | null | undefined, city: string | null | undefined): Borough | null {
  const zip = zip5(zipRaw)
  if (zip) {
    const byZip = ZIP5_BOROUGH[zip] ?? ZIP3_BOROUGH[zip.slice(0, 3)]
    if (byZip) return byZip
  }
  return CITY_INDEX.get(cityKey(city)) ?? null
}

// ─── ZIP → neighborhood ──────────────────────────────────────────────────────
// A copy of DealFlow lib/geo/zipNeighborhood.ts (Brief 34, at 66cdf07), with
// each name already put through DealFlow's canonicalizer (domain/Neighborhood
// fromRaw), so both apps say the same name. ZIPs that span several
// neighborhoods (11207, 11232, 11218) are deliberately unmapped there too.
export const NYC_ZIP_NEIGHBORHOODS: Record<string, string> = {
  '10001': 'Chelsea', '10002': 'Lower East Side', '10003': 'East Village', '10004': 'Financial District',
  '10005': 'Financial District', '10006': 'Financial District', '10007': 'Tribeca', '10010': 'Gramercy Park',
  '10011': 'Chelsea', '10012': 'Soho', '10013': 'Tribeca', '10014': 'West Village',
  '10021': 'Upper East Side', '10022': 'Upper East Side', '10023': 'Upper West Side', '10024': 'Upper West Side',
  '10025': 'Upper West Side', '10029': 'East Harlem', '10035': 'East Harlem', '10065': 'Upper East Side',
  '10075': 'Upper East Side', '10128': 'Upper East Side', '10280': 'Battery Park City',
  '11201': 'Brooklyn Heights', '11205': 'Fort Greene', '11206': 'Williamsburg', '11211': 'Williamsburg',
  '11213': 'Crown Heights', '11215': 'Park Slope', '11216': 'Crown Heights', '11217': 'Park Slope',
  '11219': 'Borough Park', '11220': 'Sunset Park', '11221': 'Bushwick', '11222': 'Greenpoint',
  '11225': 'Flatbush', '11226': 'Flatbush', '11231': 'Carroll Gardens', '11233': 'Bedford-Stuyvesant',
  '11237': 'Bushwick', '11238': 'Prospect Heights', '11249': 'Williamsburg',
  '11378': 'Maspeth', '11385': 'Ridgewood',
}

export const NEIGHBORHOODS: readonly string[] = [...new Set(Object.values(NYC_ZIP_NEIGHBORHOODS))].sort()

export function neighborhoodOf(zipRaw: string | null | undefined): string | null {
  const zip = zip5(zipRaw)
  return zip ? NYC_ZIP_NEIGHBORHOODS[zip] ?? null : null
}

// ─── Property Type → units ───────────────────────────────────────────────────
// As DealFlow lib/crm-sync/mapLead.ts (UNITS, after its whitespace clean-up),
// plus "Single Family" = 1 [CONTRACT §4]. 5 means "5 or more".
export const PROPERTY_TYPE_UNITS: Record<string, number> = {
  Duplex: 2, Triplex: 3, Quadruplex: 4, 'Apartment House (5+ Units)': 5,
}
export const SINGLE_FAMILY_PATTERN = 'single family'

/** Whitespace collapsed and trimmed, like mapLead's clean(). */
export function cleanText(raw: string | null | undefined): string {
  return (raw ?? '').replace(/\s+/g, ' ').trim()
}

export function unitsOf(propertyType: string | null | undefined): number | null {
  const t = cleanText(propertyType)
  if (!t) return null
  return PROPERTY_TYPE_UNITS[t] ?? (t.toLowerCase().includes(SINGLE_FAMILY_PATTERN) ? 1 : null)
}
