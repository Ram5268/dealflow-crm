import { resolveDb } from '@/lib/compliance/db'
import type { DncStatus } from '@/lib/compliance/dnc/check'
import type { LitigatorStatus } from '@/lib/compliance/litigator/check'
import { checkDncBatch } from '@/lib/compliance/dnc/check'
import { checkLitigatorBatch } from '@/lib/compliance/litigator/check'
import { isCircuitOpen } from '@/lib/compliance/bulk/circuitBreaker'
import { loadCheckpoint, saveCheckpoint, type CheckpointDb } from '@/lib/compliance/bulk/checkpoint'

// Bulk-scrub worker for the 25k initial load (§2g). Enqueued by Agent A's
// importer as pg-boss job `compliance:bulk-scrub` with { importBatchId,
// correlationId }. Enumerates ContactPhones via the planner-locked
// Lead.source = "import:" + importBatchId convention, chunks them, and scrubs
// DNC + litigator with checkpointing + circuit-halt. The check layers use
// createMany for ScrubLog/suppression writes (Railway perf).

export const BULK_SCRUB_JOB = 'compliance:bulk-scrub'
const DEFAULT_CHUNK = 250

export interface BulkWorkerDb extends CheckpointDb {
  contactPhone: { findMany: (args: any) => Promise<Array<{ id: string; phone: string }>> }
}

export interface BulkScrubDeps {
  db?: BulkWorkerDb
  checkDnc?: (orgId: string, phones: string[]) => Promise<Map<string, DncStatus>>
  checkLitigator?: (orgId: string, phones: string[]) => Promise<Map<string, LitigatorStatus>>
  now?: Date
  chunkSize?: number
  correlationId?: string
}

export interface BulkScrubOutcome {
  totalCount: number
  processedCount: number
  blockedCount: number
  status: 'completed' | 'halted'
  haltReason?: string
}

export async function runBulkScrub(
  input: { orgId: string; importBatchId: string },
  deps: BulkScrubDeps = {}
): Promise<BulkScrubOutcome> {
  const db = resolveDb<BulkWorkerDb>(deps.db)
  const now = deps.now ?? new Date()
  const chunkSize = deps.chunkSize ?? DEFAULT_CHUNK
  const correlationId = deps.correlationId ?? 'bulk-scrub'
  const checkDnc = deps.checkDnc ?? ((o: string, p: string[]) => checkDncBatch(o, p, { db: db as any, correlationId, now }))
  const checkLitigator =
    deps.checkLitigator ?? ((o: string, p: string[]) => checkLitigatorBatch(o, p, { db: db as any, correlationId, now }))

  // Enumerate ContactPhones in the import batch, stable ascending id order.
  const rows = await db.contactPhone.findMany({
    where: { contact: { lead: { source: `import:${input.importBatchId}` } } },
    select: { id: true, phone: true },
    orderBy: { id: 'asc' },
  })

  // Resume from the checkpoint (process only ids strictly after the last one).
  const cp = await loadCheckpoint(input.orgId, input.importBatchId, db)
  const startAfter = cp?.lastProcessedContactPhoneId ?? null
  const pending = startAfter ? rows.filter((r) => r.id > startAfter) : rows

  await saveCheckpoint(input.orgId, input.importBatchId, {
    totalCount: rows.length,
    status: 'running',
    haltReason: null,
  }, db)

  let processed = cp?.processedCount ?? 0
  let blocked = 0
  let chunkIndex = cp?.chunkIndex ?? 0

  for (let i = 0; i < pending.length; i += chunkSize) {
    if (isCircuitOpen('dnc', now.getTime())) {
      await saveCheckpoint(input.orgId, input.importBatchId, { status: 'halted', haltReason: 'circuit_open_dnc' }, db)
      return { totalCount: rows.length, processedCount: processed, blockedCount: blocked, status: 'halted', haltReason: 'circuit_open_dnc' }
    }

    const group = pending.slice(i, i + chunkSize)
    const phones = group.map((g) => g.phone)
    const dnc = await checkDnc(input.orgId, phones)
    const dncClean = phones.filter((p) => dnc.get(p)?.status === 'clean')
    const lit = await checkLitigator(input.orgId, dncClean)

    for (const p of phones) {
      const isBlocked = dnc.get(p)?.status === 'blocked' || lit.get(p)?.status === 'blocked'
      if (isBlocked) blocked++
    }

    processed += group.length
    chunkIndex++
    await saveCheckpoint(input.orgId, input.importBatchId, {
      lastProcessedContactPhoneId: group[group.length - 1].id,
      chunkIndex,
      processedCount: processed,
      status: 'running',
    }, db)
  }

  await saveCheckpoint(input.orgId, input.importBatchId, { status: 'completed' }, db)
  return { totalCount: rows.length, processedCount: processed, blockedCount: blocked, status: 'completed' }
}
