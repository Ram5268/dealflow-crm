// IANA timezone -> US state codes, many-to-many.
//
// USED FOR HOLIDAY-SCOPE RESOLUTION ONLY — never for the calling-window check
// (that reads Contact.timezone directly and converts via Intl). When a
// contact's address state is unknown, the holiday check expands to EVERY state
// in the contact's tz bucket and blocks if ANY of them has a holiday that day.
// That over-blocks (a NY-zone contact could get suppressed for a KY holiday),
// which is deliberately fail-closed: over-blocking a legal call is safe;
// under-blocking is a TCPA violation.
//
// Buckets are intentionally BROAD. §14 README lists every bucket so Ryan can
// review and prune before ship. The `America/New_York` bucket intentionally
// includes Central-time-partial states (KY, IN, MI, TN) as over-blocking.

const MAP: Record<string, readonly string[]> = {
  // Eastern — broad bucket, includes partial-Central states (fail-closed).
  'America/New_York': [
    'CT', 'DE', 'DC', 'FL', 'GA', 'IN', 'KY', 'ME', 'MD', 'MA', 'MI', 'NH',
    'NJ', 'NY', 'NC', 'OH', 'PA', 'RI', 'SC', 'TN', 'VT', 'VA', 'WV',
  ],
  'America/Detroit': ['MI'],
  'America/Indiana/Indianapolis': ['IN'],
  'America/Kentucky/Louisville': ['KY'],

  // Central.
  'America/Chicago': [
    'AL', 'AR', 'IL', 'IA', 'KS', 'LA', 'MN', 'MS', 'MO', 'NE', 'ND', 'OK',
    'SD', 'TN', 'TX', 'WI', 'KY', 'IN',
  ],

  // Mountain.
  'America/Denver': ['CO', 'ID', 'MT', 'NM', 'UT', 'WY', 'ND', 'SD', 'NE', 'KS'],
  'America/Boise': ['ID'],
  'America/Phoenix': ['AZ'], // no DST — single-state, resolves unambiguously

  // Pacific.
  'America/Los_Angeles': ['CA', 'NV', 'OR', 'WA'],

  // Non-contiguous.
  'America/Anchorage': ['AK'],
  'America/Juneau': ['AK'],
  'Pacific/Honolulu': ['HI'],
  'America/Puerto_Rico': ['PR'],
}

// Canonical 2-letter state code, or null if not a recognizable US state code.
const VALID_STATES = new Set<string>([
  'AL', 'AK', 'AZ', 'AR', 'CA', 'CO', 'CT', 'DE', 'DC', 'FL', 'GA', 'HI', 'ID',
  'IL', 'IN', 'IA', 'KS', 'KY', 'LA', 'ME', 'MD', 'MA', 'MI', 'MN', 'MS', 'MO',
  'MT', 'NE', 'NV', 'NH', 'NJ', 'NM', 'NY', 'NC', 'ND', 'OH', 'OK', 'OR', 'PA',
  'RI', 'SC', 'SD', 'TN', 'TX', 'UT', 'VT', 'VA', 'WA', 'WV', 'WI', 'WY', 'PR',
])

export function normalizeState(raw: string | null | undefined): string | null {
  if (!raw) return null
  const s = raw.trim().toUpperCase()
  return VALID_STATES.has(s) ? s : null
}

// Every US state in the tz's bucket (broad, fail-closed). Empty if unknown zone.
export function statesForTimezone(timezone: string): readonly string[] {
  return MAP[timezone] ?? []
}

// For README generation / review.
export const TZ_STATE_MAP = MAP
