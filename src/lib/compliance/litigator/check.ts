import { resolveDb } from '@/lib/compliance/db'
import type { ReasonCode } from '@/lib/compliance/reasons'
import type { LitigatorVendorClient } from '@/lib/compliance/litigator/vendors/types'
import { getLitigatorVendor } from '@/lib/compliance/litigator/vendors/index'
import { isCircuitOpen, recordVendorResult } from '@/lib/compliance/bulk/circuitBreaker'
import { VendorError } from '@/lib/compliance/errors'

// Litigator scrub with a 30-day read-through cache (§2d). A known litigator
// (LitigatorSuppression row) stays blocked; a recent clean check (<30d) is
// served from ScrubLog; unknown phones hit the live vendor (circuit-guarded).
// Any vendor error / open circuit → fail-closed.

const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000

export type LitigatorStatus =
  | { status: 'clean' }
  | { status: 'blocked'; reason: 'litigator'; detail: { vendor: string } }
  | { status: 'error'; reason: ReasonCode }

export interface LitigatorCheckDb {
  litigatorSuppression: {
    findMany: (args: any) => Promise<Array<{ phone: string; vendor: string }>>
    createMany: (args: any) => Promise<{ count: number }>
  }
  scrubLog: {
    findMany: (args: any) => Promise<Array<{ phone: string }>>
    createMany: (args: any) => Promise<{ count: number }>
  }
}

export interface LitigatorCheckDeps {
  db?: LitigatorCheckDb
  vendor?: LitigatorVendorClient
  correlationId?: string
  now?: Date
  useCircuit?: boolean
}

export async function checkLitigatorBatch(
  orgId: string,
  phones: string[],
  deps: LitigatorCheckDeps = {}
): Promise<Map<string, LitigatorStatus>> {
  const out = new Map<string, LitigatorStatus>()
  if (phones.length === 0) return out

  const db = resolveDb<LitigatorCheckDb>(deps.db)
  const vendor = deps.vendor ?? getLitigatorVendor()
  const now = deps.now ?? new Date()
  const useCircuit = deps.useCircuit ?? true
  const correlationId = deps.correlationId ?? 'litigator-check'

  // 1. Known litigators.
  const known = await db.litigatorSuppression.findMany({
    where: { organizationId: orgId, phone: { in: phones } },
    select: { phone: true, vendor: true },
  })
  for (const row of known) if (!out.has(row.phone)) out.set(row.phone, { status: 'blocked', reason: 'litigator', detail: { vendor: row.vendor } })

  // 2. Recent clean (<30d).
  const remaining = phones.filter((p) => !out.has(p))
  if (remaining.length > 0) {
    const cleanRows = await db.scrubLog.findMany({
      where: {
        organizationId: orgId,
        phone: { in: remaining },
        operation: 'check-litigator',
        result: 'clean',
        checkedAt: { gte: new Date(now.getTime() - THIRTY_DAYS_MS) },
      },
      select: { phone: true },
    })
    for (const r of cleanRows) if (!out.has(r.phone)) out.set(r.phone, { status: 'clean' })
  }

  // 3. Live vendor scrub.
  const unknown = phones.filter((p) => !out.has(p))
  if (unknown.length === 0) return out

  if (useCircuit && isCircuitOpen('litigator', now.getTime())) {
    for (const p of unknown) out.set(p, { status: 'error', reason: 'circuit_open_litigator' })
    return out
  }

  try {
    const result = await vendor.scrubBatch(unknown, { correlationId })
    if (useCircuit) recordVendorResult('litigator', true, now.getTime())

    const hits = result.perPhone.filter((r) => r.isLitigator)
    if (hits.length > 0) {
      await db.litigatorSuppression.createMany({
        data: hits.map((h) => ({ organizationId: orgId, phone: h.phone, vendor: vendor.name, vendorMatchId: h.vendorMatchId })),
        skipDuplicates: true,
      })
    }
    await db.scrubLog.createMany({
      data: result.perPhone.map((r) => ({
        organizationId: orgId,
        phone: r.phone,
        operation: 'check-litigator' as const,
        result: r.isLitigator ? 'blocked' : 'clean',
        detail: { vendor: vendor.name, correlationId },
      })),
    })

    for (const h of hits) out.set(h.phone, { status: 'blocked', reason: 'litigator', detail: { vendor: vendor.name } })
    for (const r of result.perPhone) if (!r.isLitigator && !out.has(r.phone)) out.set(r.phone, { status: 'clean' })
    for (const p of unknown) if (!out.has(p)) out.set(p, { status: 'error', reason: 'vendor_error_litigator' })
  } catch (err) {
    if (useCircuit) recordVendorResult('litigator', false, now.getTime())
    const reason = (err as VendorError)?.reason ?? 'vendor_error_litigator'
    for (const p of unknown) out.set(p, { status: 'error', reason: reason as ReasonCode })
  }

  return out
}
