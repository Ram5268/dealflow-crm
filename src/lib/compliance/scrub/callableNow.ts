import type { ReasonCode } from '@/lib/compliance/reasons'
import { BatchTooLargeError } from '@/lib/compliance/errors'
import { evaluateCallingWindow } from '@/lib/compliance/timezone/windowCheck'
import { stateFromTimezone } from '@/lib/compliance/timezone/stateFromTimezone'
import { normalizeE164 } from '@/lib/compliance/dnc/internal'
import type { PolicyGateResult } from '@/lib/compliance/policy/gate'
import type { HolidayResult } from '@/lib/compliance/holidays/check'
import type { DncStatus } from '@/lib/compliance/dnc/check'
import type { LitigatorStatus } from '@/lib/compliance/litigator/check'
import type { ScrubLogInput } from '@/lib/compliance/scrub/scrubLog'
import type { ScrubCompletedPayload } from '@/lib/compliance/events/emitScrubCompleted'

// Per-contactPhoneId real-time callable pipeline. Called INLINE by Agent B
// before every dial. Fail-closed at every step: any missing/ambiguous input
// yields callable:false with a reason from REASON_CODES — never a positive
// signal from a negative check. The M1 pipeline runs the fail-closed core only
// (timezone -> policy -> internal DNC -> window -> holiday); vendor checks
// (federal/state/litigator) join at M2.

export const CALLABLE_NOW_MAX = 100

export interface CallableNowInput {
  contactPhoneIds: string[]
  atInstant?: string // ISO; defaults to deps.now
}

export interface CallableNowResult {
  contactPhoneId: string // echo of input
  phone: string // resolved from ContactPhone row; "" when the row is missing
  callable: boolean
  reasons: ReasonCode[]
  reasonDetails?: Partial<Record<ReasonCode, unknown>>
}

export interface CallableNowResponse {
  results: CallableNowResult[]
}

// What the pipeline needs about each ContactPhone. Loaded in ONE batch query.
export interface LoadedPhone {
  phone: string
  timezone: string | null
  addressState: string | null
}

export interface CallableNowDeps {
  orgId: string
  correlationId: string
  now: Date
  loadContactPhones: (ids: string[]) => Promise<Map<string, LoadedPhone>>
  internalDncHits: (orgId: string, phones: string[]) => Promise<Set<string>>
  isPolicyConfirmed: (orgId: string, tz: string) => Promise<PolicyGateResult>
  checkHoliday: (args: {
    orgId: string
    localDate: string
    contactState: string | null
    contactTimezone: string
    freshDays?: number
  }) => Promise<HolidayResult>
  holidayFreshDays?: () => Promise<number>
  // M2 vendor steps — optional. When absent (M1), phones flow straight from
  // internal-DNC to the calling window (no vendor checks), preserving M1 behavior.
  checkDnc?: (orgId: string, phones: string[]) => Promise<Map<string, DncStatus>>
  checkLitigator?: (orgId: string, phones: string[]) => Promise<Map<string, LitigatorStatus>>
  persist: (orgId: string, logs: ScrubLogInput[], event: ScrubCompletedPayload) => Promise<void>
}

export async function runCallableNow(
  input: CallableNowInput,
  deps: CallableNowDeps
): Promise<CallableNowResponse> {
  const ids = input.contactPhoneIds
  if (ids.length > CALLABLE_NOW_MAX) {
    throw new BatchTooLargeError(CALLABLE_NOW_MAX, ids.length)
  }

  const parsed = input.atInstant ? new Date(input.atInstant) : deps.now
  const at = Number.isNaN(parsed.getTime()) ? deps.now : parsed

  const loaded = await deps.loadContactPhones(ids)
  const presentPhones = [...loaded.values()].map((l) => l.phone)
  const internalHits = await deps.internalDncHits(deps.orgId, presentPhones)
  const freshDays = deps.holidayFreshDays ? await deps.holidayFreshDays() : undefined

  // M2: batch DNC + litigator read-through once, over phones that at least have
  // a timezone (obvious non-starters are skipped; policy-unconfirmed phones
  // short-circuit before these are consulted in the loop).
  const tzPhones = [...loaded.values()].filter((l) => l.timezone && l.timezone.trim() !== '').map((l) => l.phone)
  const dncMap = deps.checkDnc ? await deps.checkDnc(deps.orgId, tzPhones) : undefined
  const litMap = deps.checkLitigator ? await deps.checkLitigator(deps.orgId, tzPhones) : undefined

  const results: CallableNowResult[] = []
  const logs: ScrubLogInput[] = []

  for (const id of ids) {
    const lp = loaded.get(id)

    // (2) ContactPhone row missing -> fail-closed phone_missing, phone "".
    if (!lp) {
      results.push({ contactPhoneId: id, phone: '', callable: false, reasons: ['phone_missing'] })
      logs.push({
        phone: '',
        contactPhoneId: id,
        operation: 'check-window',
        result: 'error',
        detail: { contactPhoneId: id, reason: 'phone_missing' },
      })
      continue
    }

    const phone = lp.phone

    // (3) Timezone missing/whitespace -> fail-closed timezone_unresolved.
    if (lp.timezone == null || lp.timezone.trim() === '') {
      results.push({ contactPhoneId: id, phone, callable: false, reasons: ['timezone_unresolved'] })
      logs.push({
        phone,
        contactPhoneId: id,
        operation: 'check-window',
        result: 'error',
        detail: { contactPhoneId: id, reason: 'timezone_unresolved' },
      })
      continue
    }
    const tz = lp.timezone.trim()

    // (4) Policy-confirmation gate.
    const gate = await deps.isPolicyConfirmed(deps.orgId, tz)
    if (!gate.confirmed || !gate.config) {
      results.push({ contactPhoneId: id, phone, callable: false, reasons: ['policy_unconfirmed'] })
      logs.push({
        phone,
        contactPhoneId: id,
        operation: 'check-window',
        result: 'error',
        detail: { reason: 'policy_unconfirmed', tz },
      })
      continue
    }

    // (5) Internal DNC (DB-only, fast).
    if (internalHits.has(normalizeE164(phone))) {
      results.push({ contactPhoneId: id, phone, callable: false, reasons: ['internal_dnc'] })
      logs.push({ phone, contactPhoneId: id, operation: 'check-internal', result: 'blocked' })
      continue
    }

    // (5b) Federal/state DNC (M2 read-through; skipped when checkDnc absent).
    const dnc = dncMap?.get(phone)
    if (dnc && dnc.status !== 'clean') {
      if (dnc.status === 'blocked') {
        const res: CallableNowResult = { contactPhoneId: id, phone, callable: false, reasons: [dnc.reason] }
        if (dnc.detail) res.reasonDetails = { [dnc.reason]: dnc.detail }
        results.push(res)
        logs.push({
          phone,
          contactPhoneId: id,
          operation: dnc.reason === 'state_dnc' ? 'check-state' : 'check-federal',
          result: 'blocked',
          detail: dnc.detail ?? { reason: dnc.reason },
        })
      } else {
        results.push({ contactPhoneId: id, phone, callable: false, reasons: [dnc.reason] })
        logs.push({ phone, contactPhoneId: id, operation: 'check-federal', result: 'error', detail: { reason: dnc.reason } })
      }
      continue
    }

    // (5c) Litigator (M2; skipped when checkLitigator absent).
    const lit = litMap?.get(phone)
    if (lit && lit.status !== 'clean') {
      if (lit.status === 'blocked') {
        results.push({ contactPhoneId: id, phone, callable: false, reasons: ['litigator'], reasonDetails: { litigator: lit.detail } })
        logs.push({ phone, contactPhoneId: id, operation: 'check-litigator', result: 'blocked', detail: lit.detail })
      } else {
        results.push({ contactPhoneId: id, phone, callable: false, reasons: [lit.reason] })
        logs.push({ phone, contactPhoneId: id, operation: 'check-litigator', result: 'error', detail: { reason: lit.reason } })
      }
      continue
    }

    // (6) Calling window (DST-aware).
    const win = evaluateCallingWindow({
      atInstant: at,
      timezone: tz,
      earliestHour: gate.config.earliestHour,
      latestHour: gate.config.latestHour,
      allowedDaysOfWeek: gate.config.allowedDaysOfWeek,
    })
    if (!win.allowed) {
      if (win.reason === 'timezone_invalid') {
        results.push({ contactPhoneId: id, phone, callable: false, reasons: ['timezone_invalid'] })
        logs.push({
          phone,
          contactPhoneId: id,
          operation: 'check-window',
          result: 'error',
          detail: { tz, reason: 'timezone_invalid' },
        })
      } else {
        const reason = win.reason as ReasonCode // outside_calling_window_hour | _day
        results.push({ contactPhoneId: id, phone, callable: false, reasons: [reason] })
        logs.push({
          phone,
          contactPhoneId: id,
          operation: 'check-window',
          result: 'blocked',
          detail: { localHour: win.localHour, localDayOfWeek: win.localDayOfWeek, reason },
        })
      }
      continue
    }

    // (7) Holiday suppression on the LOCAL date.
    const state = stateFromTimezone({ addressState: lp.addressState, timezone: tz })
    const hol = await deps.checkHoliday({
      orgId: deps.orgId,
      localDate: win.localDate,
      contactState: state,
      contactTimezone: tz,
      freshDays,
    })
    if (hol.blocked) {
      const reason = hol.reason as ReasonCode
      const res: CallableNowResult = { contactPhoneId: id, phone, callable: false, reasons: [reason] }
      if (hol.detail && (reason === 'holiday_federal' || reason === 'holiday_state')) {
        res.reasonDetails = { [reason]: hol.detail }
      }
      results.push(res)
      logs.push({
        phone,
        contactPhoneId: id,
        operation: 'check-holiday',
        result: reason === 'holiday_table_stale' ? 'error' : 'blocked',
        detail: hol.detail ?? { reason },
      })
      continue
    }

    // (8) All gates passed -> callable.
    results.push({ contactPhoneId: id, phone, callable: true, reasons: [] })
    logs.push({ phone, contactPhoneId: id, operation: 'check-window', result: 'clean' })
  }

  const event: ScrubCompletedPayload = {
    phoneCount: results.length,
    blockedCount: results.filter((r) => !r.callable).length,
    checkedAt: at.toISOString(),
    correlationId: deps.correlationId,
  }
  await deps.persist(deps.orgId, logs, event)

  return { results }
}
