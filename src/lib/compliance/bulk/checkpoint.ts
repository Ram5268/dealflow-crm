import { resolveDb } from '@/lib/compliance/db'

// Resumable bulk-scrub checkpoint. One row per (org, importBatch). On resume the
// worker continues from lastProcessedContactPhoneId so a killed 25k scrub never
// re-scrubs from zero (Ryan's Railway is ~90ms/write — restarting from scratch
// would be minutes wasted and duplicate vendor spend).

export interface BulkCheckpointRow {
  lastProcessedContactPhoneId: string | null
  chunkIndex: number
  processedCount: number
  totalCount: number
  status: string // running|halted|completed|failed
  haltReason: string | null
}

export interface CheckpointDb {
  bulkScrubCheckpoint: {
    findUnique: (args: any) => Promise<BulkCheckpointRow | null>
    upsert: (args: any) => Promise<unknown>
  }
}

export async function loadCheckpoint(
  orgId: string,
  importBatchId: string,
  db?: CheckpointDb
): Promise<BulkCheckpointRow | null> {
  const client = resolveDb<CheckpointDb>(db)
  return client.bulkScrubCheckpoint.findUnique({
    where: { organizationId_importBatchId: { organizationId: orgId, importBatchId } },
  })
}

export async function saveCheckpoint(
  orgId: string,
  importBatchId: string,
  patch: Partial<BulkCheckpointRow>,
  db?: CheckpointDb
): Promise<void> {
  const client = resolveDb<CheckpointDb>(db)
  await client.bulkScrubCheckpoint.upsert({
    where: { organizationId_importBatchId: { organizationId: orgId, importBatchId } },
    update: patch,
    create: { organizationId: orgId, importBatchId, ...patch },
  })
}
