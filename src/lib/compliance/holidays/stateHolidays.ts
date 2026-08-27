// Which jurisdictions we track for calling-window holiday suppression: all 50
// states + DC + PR. date-holidays knows US states by 2-letter code. Federal
// holidays are fetched once (scope "federal") and block every contact
// regardless of state; state-specific holidays (scope "state:XX") block only
// that state's contacts.
export const TRACKED_STATES = [
  'AL', 'AK', 'AZ', 'AR', 'CA', 'CO', 'CT', 'DE', 'DC', 'FL', 'GA', 'HI', 'ID',
  'IL', 'IN', 'IA', 'KS', 'KY', 'LA', 'ME', 'MD', 'MA', 'MI', 'MN', 'MS', 'MO',
  'MT', 'NE', 'NV', 'NH', 'NJ', 'NM', 'NY', 'NC', 'ND', 'OH', 'OK', 'OR', 'PA',
  'RI', 'SC', 'SD', 'TN', 'TX', 'UT', 'VT', 'VA', 'WA', 'WV', 'WI', 'WY', 'PR',
] as const

export type TrackedState = (typeof TRACKED_STATES)[number]
