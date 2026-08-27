import { resolveDb } from '@/lib/compliance/db'
import type { ReasonCode } from '@/lib/compliance/reasons'
import type { DncVendorClient, DncVendorResult } from '@/lib/compliance/dnc/vendors/types'
import { getDncVendor } from '@/lib/compliance/dnc/vendors/index'
import { VendorError } from '@/lib/compliance/errors'
import { isCircuitOpen, recordVendorResult } from '@/lib/compliance/bulk/circuitBreaker'

// Federal + state DNC check with a 24h read-through cache (§2b). Order per phone:
//   1. DncSuppression row (federal|state:*) present -> blocked (the read-through cache).
//   2. else a clean ScrubLog check-federal/check-state within 24h -> clean.
//   3. else live vendor scrub (circuit-guarded, 429-retry). On ANY vendor error
//      or open circuit -> fail-closed. A live hit upserts DncSuppression; a live
//      clean writes a ScrubLog so the next check inside 24h is DB-only.

const DAY_MS = 24 * 60 * 60 * 1000

export type DncStatus =
  | { status: 'clean' }
  | { status: 'blocked'; reason: 'federal_dnc' | 'state_dnc'; detail?: { state: string } }
  | { status: 'error'; reason: ReasonCode }

export interface DncCheckDb {
  dncSuppression: {
    findMany: (args: any) => Promise<Array<{ phone: string; source: string }>>
    createMany: (args: any) => Promise<{ count: number }>
  }
  scrubLog: {
    findMany: (args: any) => Promise<Array<{ phone: string }>>
    createMany: (args: any) => Promise<{ count: number }>
  }
}

export interface DncCheckDeps {
  db?: DncCheckDb
  vendor?: DncVendorClient
  correlationId?: string
  now?: Date
  useCircuit?: boolean // default true
  sleep?: (ms: number) => Promise<void>
}

function statusFromSource(source: string): DncStatus {
  if (source === 'federal') return { status: 'blocked', reason: 'federal_dnc' }
  /* v8 ignore next -- sources reaching here are always 'state:XX' (the OR-filtered query only returns federal|state:*) */
  const state = source.startsWith('state:') ? source.slice('state:'.length) : ''
  return { status: 'blocked', reason: 'state_dnc', detail: { state } }
}

async function scrubWithRetry(
  vendor: DncVendorClient,
  phones: string[],
  correlationId: string,
  sleep: (ms: number) => Promise<void>
): Promise<DncVendorResult> {
  let lastErr: unknown
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      return await vendor.scrubBatch(phones, { correlationId })
    } catch (err) {
      lastErr = err
      const status = (err as VendorError)?.detail?.status
      if (status !== 429) throw err // non-429 → fail-closed immediately
      await sleep(2 ** attempt * 100) // 429 → exponential backoff, then retry
    }
  }
  throw lastErr
}

export async function checkDncBatch(
  orgId: string,
  phones: string[],
  deps: DncCheckDeps = {}
): Promise<Map<string, DncStatus>> {
  const out = new Map<string, DncStatus>()
  if (phones.length === 0) return out

  const db = resolveDb<DncCheckDb>(deps.db)
  const vendor = deps.vendor ?? getDncVendor()
  const now = deps.now ?? new Date()
  const useCircuit = deps.useCircuit ?? true
  const correlationId = deps.correlationId ?? 'dnc-check'
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)))

  // 1. Read-through: existing federal/state suppressions.
  const suppression = await db.dncSuppression.findMany({
    where: { organizationId: orgId, phone: { in: phones }, OR: [{ source: 'federal' }, { source: { startsWith: 'state:' } }] },
    select: { phone: true, source: true },
  })
  const blocked = new Map<string, string>()
  for (const row of suppression) if (!blocked.has(row.phone)) blocked.set(row.phone, row.source)
  for (const [phone, source] of blocked) out.set(phone, statusFromSource(source))

  // 2. Recent clean check (<24h) for the rest.
  const remaining = phones.filter((p) => !out.has(p))
  if (remaining.length > 0) {
    const cleanRows = await db.scrubLog.findMany({
      where: {
        organizationId: orgId,
        phone: { in: remaining },
        operation: { in: ['check-federal', 'check-state'] },
        result: 'clean',
        checkedAt: { gte: new Date(now.getTime() - DAY_MS) },
      },
      select: { phone: true },
    })
    /* v8 ignore next -- cleanRows ⊆ remaining, which already excludes phones in `out`; guard is defensive */
    for (const r of cleanRows) if (!out.has(r.phone)) out.set(r.phone, { status: 'clean' })
  }

  // 3. Live vendor scrub for still-unknown phones.
  const unknown = phones.filter((p) => !out.has(p))
  if (unknown.length === 0) return out

  if (useCircuit && isCircuitOpen('dnc', now.getTime())) {
    for (const p of unknown) out.set(p, { status: 'error', reason: 'circuit_open_dnc' })
    return out
  }

  try {
    const result = await scrubWithRetry(vendor, unknown, correlationId, sleep)
    if (useCircuit) recordVendorResult('dnc', true, now.getTime())

    const hits = result.perPhone.filter((r) => r.onList)
    const cleans = result.perPhone.filter((r) => !r.onList)

    if (hits.length > 0) {
      await db.dncSuppression.createMany({
        data: hits.map((h) => ({ organizationId: orgId, phone: h.phone, source: h.list, addedBy: 'sync' })),
        skipDuplicates: true,
      })
    }
    await db.scrubLog.createMany({
      data: result.perPhone.map((r) => ({
        organizationId: orgId,
        phone: r.phone,
        operation: r.list.startsWith('state:') ? 'check-state' : 'check-federal',
        result: r.onList ? 'blocked' : 'clean',
        detail: { vendor: vendor.name, onList: r.onList, list: r.list, correlationId },
      })),
    })

    for (const h of hits) out.set(h.phone, statusFromSource(h.list))
    for (const c of cleans) if (!out.has(c.phone)) out.set(c.phone, { status: 'clean' })
    // Any phone the vendor omitted → fail-closed.
    for (const p of unknown) if (!out.has(p)) out.set(p, { status: 'error', reason: 'vendor_error_dnc' })
  } catch (err) {
    if (useCircuit) recordVendorResult('dnc', false, now.getTime())
    const reason = (err as VendorError)?.reason ?? 'vendor_error_dnc'
    for (const p of unknown) out.set(p, { status: 'error', reason: reason as ReasonCode })
  }

  return out
}
