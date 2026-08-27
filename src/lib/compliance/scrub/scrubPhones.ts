import type { ReasonCode } from '@/lib/compliance/reasons'
import { normalizeE164 } from '@/lib/compliance/dnc/internal'
import type { DncStatus } from '@/lib/compliance/dnc/check'
import type { LitigatorStatus } from '@/lib/compliance/litigator/check'
import type { ScrubLogInput } from '@/lib/compliance/scrub/scrubLog'
import type { ScrubCompletedPayload } from '@/lib/compliance/events/emitScrubCompleted'

// Bulk suppression scrub (§7.1 / §2f). Populates + reads the DNC/litigator
// suppression lists and reports per-phone `callable` reflecting SUPPRESSION
// status: policy gate → internal DNC → federal → state → litigator. The
// dial-instant checks (calling window, holiday) are enforced by callable-now at
// dial time — this endpoint answers "is this number on a do-not-call list",
// which is stable across the day. One scrub.completed is emitted per call.

export interface ScrubPhoneResult {
  phone: string
  callable: boolean
  reasons: ReasonCode[]
  reasonDetails?: Partial<Record<ReasonCode, unknown>>
}

export interface ScrubPhonesDeps {
  orgId: string
  correlationId: string
  now: Date
  hasAnyConfirmedPolicy: (orgId: string) => Promise<boolean>
  internalDncHits: (orgId: string, phones: string[]) => Promise<Set<string>>
  checkDnc: (orgId: string, phones: string[]) => Promise<Map<string, DncStatus>>
  checkLitigator: (orgId: string, phones: string[]) => Promise<Map<string, LitigatorStatus>>
  persist: (orgId: string, logs: ScrubLogInput[], event: ScrubCompletedPayload) => Promise<void>
}

export async function scrubPhones(
  phones: string[],
  deps: ScrubPhonesDeps
): Promise<{ results: ScrubPhoneResult[]; scrubbedAt: string }> {
  const scrubbedAt = deps.now.toISOString()
  const results: ScrubPhoneResult[] = []
  const logs: ScrubLogInput[] = []

  // §2f step 1: no confirmed policy anywhere → block ALL before spending vendor $.
  if (!(await deps.hasAnyConfirmedPolicy(deps.orgId))) {
    for (const phone of phones) {
      results.push({ phone, callable: false, reasons: ['policy_unconfirmed'] })
      logs.push({ phone, operation: 'check-window', result: 'error', detail: { reason: 'policy_unconfirmed' } })
    }
    await finish(deps, logs, results, scrubbedAt)
    return { results, scrubbedAt }
  }

  const internal = await deps.internalDncHits(deps.orgId, phones)
  const afterInternal = phones.filter((p) => !internal.has(normalizeE164(p)))
  const dncMap = await deps.checkDnc(deps.orgId, afterInternal)
  const dncClean = afterInternal.filter((p) => dncMap.get(p)?.status === 'clean')
  const litMap = await deps.checkLitigator(deps.orgId, dncClean)

  for (const phone of phones) {
    if (internal.has(normalizeE164(phone))) {
      results.push({ phone, callable: false, reasons: ['internal_dnc'] })
      logs.push({ phone, operation: 'check-internal', result: 'blocked' })
      continue
    }
    const dnc = dncMap.get(phone)
    if (dnc && dnc.status !== 'clean') {
      if (dnc.status === 'blocked') {
        const r: ScrubPhoneResult = { phone, callable: false, reasons: [dnc.reason] }
        if (dnc.detail) r.reasonDetails = { [dnc.reason]: dnc.detail }
        results.push(r)
        logs.push({ phone, operation: dnc.reason === 'state_dnc' ? 'check-state' : 'check-federal', result: 'blocked', detail: dnc.detail ?? { reason: dnc.reason } })
      } else {
        results.push({ phone, callable: false, reasons: [dnc.reason] })
        logs.push({ phone, operation: 'check-federal', result: 'error', detail: { reason: dnc.reason } })
      }
      continue
    }
    const lit = litMap.get(phone)
    if (lit && lit.status !== 'clean') {
      if (lit.status === 'blocked') {
        results.push({ phone, callable: false, reasons: ['litigator'], reasonDetails: { litigator: lit.detail } })
        logs.push({ phone, operation: 'check-litigator', result: 'blocked', detail: lit.detail })
      } else {
        results.push({ phone, callable: false, reasons: [lit.reason] })
        logs.push({ phone, operation: 'check-litigator', result: 'error', detail: { reason: lit.reason } })
      }
      continue
    }
    results.push({ phone, callable: true, reasons: [] })
    logs.push({ phone, operation: 'check-internal', result: 'clean' })
  }

  await finish(deps, logs, results, scrubbedAt)
  return { results, scrubbedAt }
}

async function finish(deps: ScrubPhonesDeps, logs: ScrubLogInput[], results: ScrubPhoneResult[], scrubbedAt: string) {
  await deps.persist(deps.orgId, logs, {
    phoneCount: results.length,
    blockedCount: results.filter((r) => !r.callable).length,
    checkedAt: scrubbedAt,
    correlationId: deps.correlationId,
  })
}
