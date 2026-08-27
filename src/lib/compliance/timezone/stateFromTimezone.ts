import { normalizeState, statesForTimezone } from '@/lib/compliance/timezone/tzStateMap'

// Resolve the canonical US state for HOLIDAY-SCOPE resolution (never for the
// calling-window check). Preference order:
//   1. The contact's address state (Agent A stores addresses as a JSON array on
//      Lead; the caller passes addresses[0].state).
//   2. If no address state but the timezone maps to exactly ONE state
//      (America/Phoenix -> AZ, Pacific/Honolulu -> HI, etc.), that state.
//   3. Otherwise null — the holiday check then expands the whole tz bucket and
//      over-blocks (fail-closed).
export function stateFromTimezone(input: {
  addressState?: string | null
  timezone: string
}): string | null {
  const fromAddress = normalizeState(input.addressState)
  if (fromAddress) return fromAddress

  const bucket = statesForTimezone(input.timezone)
  if (bucket.length === 1) return bucket[0]

  return null
}
