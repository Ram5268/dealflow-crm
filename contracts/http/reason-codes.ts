import { z } from 'zod'

// Shared compliance vocabulary. Every callable-now / scrub reason MUST be one
// of these codes. Owned by the shell so all four slices agree on the enum.
export const REASON_CODES = [
  'internal_dnc', 'federal_dnc', 'state_dnc', 'litigator',
  'outside_calling_window_hour', 'outside_calling_window_day',
  'holiday_federal', 'holiday_state', 'policy_unconfirmed',
  'timezone_unresolved', 'vendor_error', 'window_stale',
] as const

export type ReasonCode = (typeof REASON_CODES)[number]

export const reasonCodeSchema = z.enum(REASON_CODES)
