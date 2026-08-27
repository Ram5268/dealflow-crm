// Public API surface for the compliance slice.
//
// The frozen reason vocabulary is re-exported here (single source of truth is
// contracts/http/reason-codes.ts). Everything else this slice exposes to the
// rest of the app is added as milestones land.

export { REASON_CODES, reasonCodeSchema } from '@/lib/compliance/reasons'
export type { ReasonCode } from '@/lib/compliance/reasons'

export {
  ComplianceError,
  TimezoneUnresolvedError,
  TimezoneInvalidError,
  PolicyUnconfirmedError,
  PhoneMissingError,
  HolidayTableStaleError,
  VendorError,
  CircuitOpenError,
  BatchTooLargeError,
} from '@/lib/compliance/errors'

export { getEnv, isDncVendorConfigured, isLitigatorVendorConfigured } from '@/lib/compliance/env'
