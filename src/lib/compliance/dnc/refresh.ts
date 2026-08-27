import { resolveDb } from '@/lib/compliance/db'
import type { DncVendorClient } from '@/lib/compliance/dnc/vendors/types'
import { getDncVendor } from '@/lib/compliance/dnc/vendors/index'
import { recordVendorResult, isCircuitOpen } from '@/lib/compliance/bulk/circuitBreaker'
import { VendorError } from '@/lib/compliance/errors'

// Nightly full re-scrub of ALL ContactPhones against the federal + state DNC
// vendor (§7.8). Upserts hits; REMOVES federal/state suppression rows whose
// phone is no longer on the list. Internal DNC is NEVER removed here. Circuit
// breaker halts on a flapping vendor.

export interface DncRefreshDb {
  contactPhone: { findMany: (args: any) => Promise<Array<{ phone: string }>> }
  dncSuppression: {
    createMany: (args: any) => Promise<{ count: number }>
    deleteMany: (args: any) => Promise<{ count: number }>
  }
  scrubLog: { createMany: (args: any) => Promise<{ count: number }> }
}

export interface DncRefreshDeps {
  db?: DncRefreshDb
  vendor?: DncVendorClient
  correlationId?: string
  now?: Date
  chunkSize?: number
}

function chunk<T>(arr: T[], size: number): T[][] {
  const out: T[][] = []
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size))
  return out
}

export async function runDncRefresh(
  orgId: string,
  deps: DncRefreshDeps = {}
): Promise<{ scanned: number; blocked: number; removed: number; halted: boolean }> {
  const db = resolveDb<DncRefreshDb>(deps.db)
  const vendor = deps.vendor ?? getDncVendor()
  const now = deps.now ?? new Date()
  const correlationId = deps.correlationId ?? 'dnc-refresh'
  const size = deps.chunkSize ?? Math.max(1, vendor.batchSize)

  const rows = await db.contactPhone.findMany({
    where: { contact: { organizationId: orgId }, phone: { not: null } },
    select: { phone: true },
  })
  const phones = [...new Set(rows.map((r) => r.phone))]

  let blocked = 0
  let removed = 0
  for (const group of chunk(phones, size)) {
    if (isCircuitOpen('dnc', now.getTime())) return { scanned: phones.length, blocked, removed, halted: true }

    let result
    try {
      result = await vendor.scrubBatch(group, { correlationId })
      recordVendorResult('dnc', true, now.getTime())
    } catch (err) {
      recordVendorResult('dnc', false, now.getTime())
      // Fail-closed: leave existing suppressions untouched, log, keep going to
      // let the circuit trip if the vendor is truly down.
      await db.scrubLog.createMany({
        data: group.map((phone) => ({
          organizationId: orgId,
          phone,
          operation: 'check-federal' as const,
          result: 'error' as const,
          detail: { vendor: vendor.name, error: String((err as VendorError)?.reason ?? err), correlationId },
        })),
      })
      continue
    }

    const hits = result.perPhone.filter((r) => r.onList)
    const cleans = result.perPhone.filter((r) => !r.onList).map((r) => r.phone)

    if (hits.length > 0) {
      const up = await db.dncSuppression.createMany({
        data: hits.map((h) => ({ organizationId: orgId, phone: h.phone, source: h.list, addedBy: 'sync' })),
        skipDuplicates: true,
      })
      blocked += up.count
    }
    // Remove federal/state rows for phones now clean (internal untouched).
    if (cleans.length > 0) {
      const del = await db.dncSuppression.deleteMany({
        where: { organizationId: orgId, phone: { in: cleans }, OR: [{ source: 'federal' }, { source: { startsWith: 'state:' } }] },
      })
      removed += del.count
    }
    await db.scrubLog.createMany({
      data: result.perPhone.map((r) => ({
        organizationId: orgId,
        phone: r.phone,
        operation: r.list.startsWith('state:') ? 'check-state' : 'check-federal',
        result: r.onList ? 'blocked' : 'clean',
        detail: { vendor: vendor.name, correlationId },
      })),
    })
  }

  return { scanned: phones.length, blocked, removed, halted: false }
}
