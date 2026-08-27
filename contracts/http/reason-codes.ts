import { z } from 'zod'

// Shared compliance vocabulary — the SINGLE source of truth for every
// callable-now / scrub `reasons[]` value. Owned by Agent C (compliance),
// published centrally so all four slices agree on the enum. Agents A and B
// import THIS file; their contract tests assert every observed reason is a
// member of REASON_CODES.
//
// Planner-ratified 2026-08-27 to Brief C §7A (granular 19-code list). This
// supersedes the earlier 12-code placeholder (which used the coarse
// `vendor_error` / `window_stale`). Granularity is load-bearing: the §11
// fail-closed matrix is the operational contract Agent B relies on, and a TCPA
// audit trail must distinguish a vendor timeout from an open circuit-breaker
// from a config gap. Adding/removing a code is a §12 contract change — STOP and
// route through the planner.
export const REASON_CODES = [
  'internal_dnc',
  'federal_dnc',
  'state_dnc', // detail carries the state code, e.g. { state: "NY" }
  'litigator', // detail carries the vendor, e.g. { vendor: "blacklist_alliance" }
  'outside_calling_window_hour', // local hour outside earliestHour..latestHour
  'outside_calling_window_day', // local dayOfWeek not in allowedDaysOfWeek
  'holiday_federal', // detail: { name }
  'holiday_state', // detail: { state, name }
  'holiday_table_stale',
  'policy_unconfirmed',
  'timezone_unresolved',
  'timezone_invalid',
  'vendor_error_dnc',
  'vendor_error_litigator',
  'vendor_error_mobile_line',
  'vendor_error_not_configured',
  'circuit_open_dnc',
  'circuit_open_litigator',
  'phone_missing', // for phone-less contacts (see §11)
] as const

export type ReasonCode = (typeof REASON_CODES)[number]

export const reasonCodeSchema = z.enum(REASON_CODES)
