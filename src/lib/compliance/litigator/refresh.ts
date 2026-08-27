import { resolveDb } from '@/lib/compliance/db'
import type { LitigatorVendorClient } from '@/lib/compliance/litigator/vendors/types'
import { getLitigatorVendor } from '@/lib/compliance/litigator/vendors/index'
import { recordVendorResult, isCircuitOpen } from '@/lib/compliance/bulk/circuitBreaker'

// Periodic litigator re-scrub. Litigator lists are additive (numbers rarely come
// off), so this only UPSERTS new hits — it never removes an existing litigator
// block. Circuit-guarded.

export interface LitigatorRefreshDb {
  contactPhone: { findMany: (args: any) => Promise<Array<{ phone: string }>> }
  litigatorSuppression: { createMany: (args: any) => Promise<{ count: number }> }
  scrubLog: { createMany: (args: any) => Promise<{ count: number }> }
}

export interface LitigatorRefreshDeps {
  db?: LitigatorRefreshDb
  vendor?: LitigatorVendorClient
  correlationId?: string
  now?: Date
  chunkSize?: number
}

export async function runLitigatorRefresh(
  orgId: string,
  deps: LitigatorRefreshDeps = {}
): Promise<{ scanned: number; blocked: number; halted: boolean }> {
  const db = resolveDb<LitigatorRefreshDb>(deps.db)
  const vendor = deps.vendor ?? getLitigatorVendor()
  const now = deps.now ?? new Date()
  const correlationId = deps.correlationId ?? 'litigator-refresh'
  const size = deps.chunkSize ?? Math.max(1, vendor.batchSize)

  const rows = await db.contactPhone.findMany({
    where: { contact: { organizationId: orgId }, phone: { not: null } },
    select: { phone: true },
  })
  const phones = [...new Set(rows.map((r) => r.phone))]

  let blocked = 0
  for (let i = 0; i < phones.length; i += size) {
    if (isCircuitOpen('litigator', now.getTime())) return { scanned: phones.length, blocked, halted: true }
    const group = phones.slice(i, i + size)
    try {
      const result = await vendor.scrubBatch(group, { correlationId })
      recordVendorResult('litigator', true, now.getTime())
      const hits = result.perPhone.filter((r) => r.isLitigator)
      if (hits.length > 0) {
        const up = await db.litigatorSuppression.createMany({
          data: hits.map((h) => ({ organizationId: orgId, phone: h.phone, vendor: vendor.name, vendorMatchId: h.vendorMatchId })),
          skipDuplicates: true,
        })
        blocked += up.count
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
    } catch {
      recordVendorResult('litigator', false, now.getTime())
    }
  }
  return { scanned: phones.length, blocked, halted: false }
}
