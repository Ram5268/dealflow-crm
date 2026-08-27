import type { ReasonCode } from '@/lib/compliance/reasons'

// Typed errors for the compliance slice. Every fail-closed error carries the
// REASON_CODE it maps to, so the pipeline can turn any thrown error into a
// `callable: false` result with the correct reason without a big switch.
//
// The cardinal rule of this slice: an error is ALWAYS a block, never a pass.
// If you add a new error type, give it a reason from REASON_CODES.

export class ComplianceError extends Error {
  readonly reason: ReasonCode
  readonly detail?: Record<string, unknown>
  constructor(reason: ReasonCode, message: string, detail?: Record<string, unknown>) {
    super(message)
    this.name = new.target.name
    this.reason = reason
    this.detail = detail
  }
}

export class TimezoneUnresolvedError extends ComplianceError {
  constructor(detail?: Record<string, unknown>) {
    super('timezone_unresolved', 'Contact timezone is null/empty; fail-closed.', detail)
  }
}

export class TimezoneInvalidError extends ComplianceError {
  constructor(tz: string, detail?: Record<string, unknown>) {
    super('timezone_invalid', `Invalid IANA timezone: ${tz}`, { tz, ...detail })
  }
}

export class PolicyUnconfirmedError extends ComplianceError {
  constructor(detail?: Record<string, unknown>) {
    super('policy_unconfirmed', 'CallingWindowConfig missing or unconfirmed; fail-closed.', detail)
  }
}

export class PhoneMissingError extends ComplianceError {
  constructor(detail?: Record<string, unknown>) {
    super('phone_missing', 'ContactPhone row missing or has null phone; fail-closed.', detail)
  }
}

export class HolidayTableStaleError extends ComplianceError {
  constructor(detail?: Record<string, unknown>) {
    super('holiday_table_stale', 'HolidaySuppressionDate table is stale (>40d); fail-closed.', detail)
  }
}

// Vendor errors carry which family failed so the reason is granular
// (vendor_error_dnc vs vendor_error_litigator vs vendor_error_mobile_line).
export class VendorError extends ComplianceError {
  constructor(reason: ReasonCode, vendor: string, detail?: Record<string, unknown>) {
    super(reason, `Vendor error (${vendor})`, { vendor, ...detail })
  }
}

export class CircuitOpenError extends ComplianceError {
  constructor(reason: ReasonCode, detail?: Record<string, unknown>) {
    super(reason, 'Vendor circuit-breaker is OPEN; fail-closed.', detail)
  }
}

// Request-level: too many contactPhoneIds. Surfaced as HTTP 413, not a
// per-phone reason.
export class BatchTooLargeError extends Error {
  readonly maxItems: number
  readonly receivedItems: number
  constructor(maxItems: number, receivedItems: number) {
    super(`Batch too large: ${receivedItems} > ${maxItems}`)
    this.name = 'BatchTooLargeError'
    this.maxItems = maxItems
    this.receivedItems = receivedItems
  }
}
