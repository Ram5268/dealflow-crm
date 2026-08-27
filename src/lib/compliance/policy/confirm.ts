import { resolveDb } from '@/lib/compliance/db'
import { invalidatePolicyCaches } from '@/lib/compliance/caches'
import type { CallingWindowConfigRow } from '@/lib/compliance/policy/gate'

// Ryan writes a CallingWindowConfig here after conferring with counsel. Setting
// policyConfirmedBy (a structured attestation) + policyConfirmedAt is what
// flips the policy gate to confirmed for that timezone.

export interface ConfirmPolicyInput {
  timezone: string
  earliestHour: number
  latestHour: number
  allowedDaysOfWeek: number[]
  policyConfirmedBy: string // "user:<email>|counsel:<name>|date:<YYYY-MM-DD>", min 20 chars
}

export class PolicyValidationError extends Error {
  readonly status = 400
  constructor(message: string) {
    super(message)
    this.name = 'PolicyValidationError'
  }
}

export function isValidIana(tz: string): boolean {
  try {
    // Probe: constructing with an invalid timeZone throws RangeError.
    new Intl.DateTimeFormat('en-US', { timeZone: tz })
    return true
  } catch {
    return false
  }
}

// Mirrors §7.5 validation. Returns the first failure message, or null if valid.
export function validateConfirmInput(input: ConfirmPolicyInput): string | null {
  if (!Number.isInteger(input.earliestHour) || input.earliestHour < 0 || input.earliestHour > 23) {
    return 'earliestHour must be an integer 0-23'
  }
  if (!Number.isInteger(input.latestHour) || input.latestHour < 1 || input.latestHour > 24) {
    return 'latestHour must be an integer 1-24'
  }
  if (input.earliestHour >= input.latestHour) {
    return 'earliestHour must be < latestHour'
  }
  if (
    !Array.isArray(input.allowedDaysOfWeek) ||
    input.allowedDaysOfWeek.length === 0 ||
    input.allowedDaysOfWeek.some((d) => !Number.isInteger(d) || d < 0 || d > 6)
  ) {
    return 'allowedDaysOfWeek must be a non-empty subset of 0..6'
  }
  if (typeof input.policyConfirmedBy !== 'string' || input.policyConfirmedBy.length < 20) {
    return 'policyConfirmedBy must be a string of at least 20 characters'
  }
  if (!isValidIana(input.timezone)) {
    return 'timezone must be a valid IANA identifier'
  }
  return null
}

export interface PolicyWriteDb {
  callingWindowConfig: { upsert: (args: any) => Promise<CallingWindowConfigRow> }
}

export async function confirmPolicy(
  orgId: string,
  input: ConfirmPolicyInput,
  opts: { db?: PolicyWriteDb; now?: Date } = {}
): Promise<CallingWindowConfigRow> {
  const error = validateConfirmInput(input)
  if (error) throw new PolicyValidationError(error)

  const db = resolveDb<PolicyWriteDb>(opts.db)
  const now = opts.now ?? new Date()
  const data = {
    earliestHour: input.earliestHour,
    latestHour: input.latestHour,
    allowedDaysOfWeek: input.allowedDaysOfWeek,
    policyConfirmedBy: input.policyConfirmedBy,
    policyConfirmedAt: now,
  }
  const row = await db.callingWindowConfig.upsert({
    where: { organizationId_timezone: { organizationId: orgId, timezone: input.timezone } },
    create: { organizationId: orgId, timezone: input.timezone, ...data },
    update: data,
  })

  // Invalidate the hot-path caches so the next callable-now sees the change
  // without waiting for the 5-minute TTL.
  invalidatePolicyCaches(orgId, input.timezone)
  return row
}
