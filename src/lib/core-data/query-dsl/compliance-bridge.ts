import { areReasonsKnown, isReasonCode, unknownReasons } from '@/lib/shared/reason-codes'
import type { ReasonCode } from '@/lib/shared/reason-codes'
import { captureException, captureWarning } from '@/lib/shared/sentry'

// A's single fail-closed reason code. Typed as ReasonCode on purpose: when the
// shared enum changes (e.g. Agent C's PR#2 rewrite drops the coarse `vendor_error`
// in favour of vendor-specific variants + the service-level `compliance_unavailable`),
// this line breaks the BUILD loudly instead of silently shipping a stale code on
// the compliance-outage path — the exact silent-failure shape the audit caught.
// PR#2 REMAP TARGET: 'compliance_unavailable' (service-level fail-closed) once C
// re-adds it. Do not map to any `vendor_error_*` variant — A never learns which
// vendor failed when C itself is unreachable/omitting.
export const FAIL_CLOSED_REASON: ReasonCode = 'compliance_unavailable'

// ─────────────────────────────────────────────────────────────────────────────
// Compliance bridge — the ONLY path from A into Agent C's callable-now service.
//
// Fail-closed by construction (brief §7 step 5 / §11):
//  - transport error / 5xx / timeout / malformed body / missing entry for a
//    submitted phone → that phone (or whole batch) is callable:false.
//  - a whole-batch failure additionally flags `connectivityFailure` so /api/queue
//    can set stale=true.
//  - a returned reason outside REASON_CODES → that phone callable:false + Sentry
//    warning, but does NOT flag connectivity (contract drift, not an outage).
//
// Batch cap is a locked contract: max 100 ids/request. Any attempt to configure
// above 100 fails loudly.
// ─────────────────────────────────────────────────────────────────────────────

export interface CallableEntry {
  contactPhoneId: string
  phone: string
  timezone?: string
}

export interface PhoneVerdict {
  callable: boolean
  // ReasonCode[], not string[]: every reason A emits is compile-time checked
  // against the shared enum, so the central vocabulary is a real drift tripwire
  // rather than a comment. C's raw wire reasons stay `string[]` (RawResult) and
  // are vetted/narrowed before they reach a verdict.
  reasons: ReasonCode[]
}

export interface ComplianceOutcome {
  byPhoneId: Map<string, PhoneVerdict>
  connectivityFailure: boolean
}

interface RawResult {
  contactPhoneId: string
  phone: string
  callable: boolean
  reasons: string[]
  reasonDetails?: Record<string, unknown>
}

// A batch caller returns the raw results array or throws on any transport/HTTP
// error. Injectable so unit tests don't need a live server.
export type BatchCaller = (body: {
  contactPhoneIds: string[]
  entries: CallableEntry[]
  atInstant?: string
}) => Promise<RawResult[]>

export const HARD_BATCH_CAP = 100

export function resolveBatchSize(): number {
  const raw = process.env.COMPLIANCE_CALLABLE_BATCH_SIZE
  const size = raw ? Number(raw) : HARD_BATCH_CAP
  if (!Number.isFinite(size) || size < 1) return HARD_BATCH_CAP
  if (size > HARD_BATCH_CAP) {
    throw new Error(
      `COMPLIANCE_CALLABLE_BATCH_SIZE=${size} exceeds the locked contract cap of ${HARD_BATCH_CAP}. ` +
        'Raising it requires a contract change routed through the planner.'
    )
  }
  return size
}

function defaultCaller(baseUrl: string, timeoutMs: number): BatchCaller {
  return async (body) => {
    const controller = new AbortController()
    const t = setTimeout(() => controller.abort(), timeoutMs)
    try {
      const res = await fetch(`${baseUrl}/api/compliance/callable-now`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
        signal: controller.signal,
      })
      if (!res.ok) throw new Error(`compliance responded ${res.status}`)
      const json = (await res.json()) as { results?: unknown }
      if (!json || !Array.isArray(json.results)) {
        throw new Error('compliance response missing results[]')
      }
      return json.results as RawResult[]
    } finally {
      clearTimeout(t)
    }
  }
}

export interface CheckOptions {
  caller?: BatchCaller
  batchSize?: number
  atInstant?: string
  baseUrl?: string
  timeoutMs?: number
}

function chunk<T>(arr: T[], size: number): T[][] {
  const out: T[][] = []
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size))
  return out
}

export async function checkCallable(
  entries: CallableEntry[],
  opts: CheckOptions = {}
): Promise<ComplianceOutcome> {
  const byPhoneId = new Map<string, PhoneVerdict>()
  let connectivityFailure = false
  if (entries.length === 0) return { byPhoneId, connectivityFailure }

  const batchSize = opts.batchSize ?? resolveBatchSize()
  const baseUrl = opts.baseUrl ?? process.env.COMPLIANCE_BASE_URL ?? 'http://localhost:5555'
  const caller = opts.caller ?? defaultCaller(baseUrl, opts.timeoutMs ?? 8_000)

  for (const batch of chunk(entries, batchSize)) {
    const body = {
      contactPhoneIds: batch.map((e) => e.contactPhoneId),
      entries: batch,
      atInstant: opts.atInstant,
    }
    let results: RawResult[]
    try {
      results = await caller(body)
    } catch (err) {
      // Whole-batch fail-closed + connectivity flag.
      captureException(err, { dependency: 'compliance.callable-now', event: 'batch-failure' })
      connectivityFailure = true
      for (const e of batch) {
        byPhoneId.set(e.contactPhoneId, { callable: false, reasons: [FAIL_CLOSED_REASON] })
      }
      continue
    }

    const resultById = new Map(results.map((r) => [r.contactPhoneId, r]))
    for (const e of batch) {
      const r = resultById.get(e.contactPhoneId)
      if (!r) {
        // Missing entry for a submitted id → fail-closed for that phone.
        captureWarning('compliance omitted a submitted phone id', {
          dependency: 'compliance.callable-now',
          contactPhoneId: e.contactPhoneId,
        })
        byPhoneId.set(e.contactPhoneId, { callable: false, reasons: [FAIL_CLOSED_REASON] })
        continue
      }
      if (!areReasonsKnown(r.reasons)) {
        captureWarning('compliance returned unknown REASON_CODE', {
          dependency: 'compliance.callable-now',
          contactPhoneId: e.contactPhoneId,
          unknown: unknownReasons(r.reasons),
        })
        // Fail-closed. Forward only the KNOWN subset of C's reasons (type-safe);
        // the raw unknown codes are preserved in the Sentry warning above. Never
        // emit an empty reasons array on a callable:false verdict.
        const known = r.reasons.filter(isReasonCode)
        byPhoneId.set(e.contactPhoneId, {
          callable: false,
          reasons: known.length ? known : [FAIL_CLOSED_REASON],
        })
        continue
      }
      // r.reasons narrowed to ReasonCode[] by the areReasonsKnown type guard.
      byPhoneId.set(e.contactPhoneId, { callable: r.callable, reasons: r.reasons })
    }
  }

  return { byPhoneId, connectivityFailure }
}
