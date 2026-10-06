import type { Prisma, PrismaClient } from '@prisma/client'
import type { MappingProposal } from './ai-mapping'

// ─────────────────────────────────────────────────────────────────────────────
// Import batch status helpers (Brief 41, M25), shared by the import routes and
// tested against the perf DB.
// ─────────────────────────────────────────────────────────────────────────────

// What the progress page needs. Never the raw file (sourceBlob: the whole
// homeowner list, ~12x its size as JSON, over Vercel's response cap) or the
// mapping.
export const IMPORT_STATUS_SELECT = {
  id: true,
  organizationId: true,
  sourceLabel: true,
  filename: true,
  status: true,
  totalRows: true,
  importedRows: true,
  duplicateRows: true,
  skippedRows: true,
  errorRows: true,
  errorLog: true,
  createdAt: true,
  completedAt: true,
} satisfies Prisma.ImportBatchSelect

export async function getImportStatus(db: PrismaClient, id: string, organizationId: string) {
  const batch = await db.importBatch.findFirst({ where: { id, organizationId }, select: IMPORT_STATUS_SELECT })
  if (!batch) return null
  const progress =
    batch.totalRows > 0
      ? Math.round(((batch.importedRows + batch.skippedRows + batch.errorRows) / batch.totalRows) * 100)
      : batch.status === 'completed'
        ? 100
        : 0
  return { ...batch, progress }
}

// A commit may start from these. 'failed' allows a retry; a batch that is
// 'importing' or 'completed' never runs again.
const COMMITTABLE = ['pending', 'mapping_review', 'failed']

export type CommitClaim = { claimed: true } | { claimed: false; status: string | null }

// Atomically moves the batch to 'importing' (one UPDATE with the status in the
// WHERE), so two clicks or a retried request can't start two commits.
export async function claimImportCommit(
  db: PrismaClient,
  id: string,
  organizationId: string,
  mapping: MappingProposal,
): Promise<CommitClaim> {
  const { count } = await db.importBatch.updateMany({
    where: { id, organizationId, status: { in: COMMITTABLE } },
    data: {
      status: 'importing',
      mappingJson: mapping as object,
      importedRows: 0,
      duplicateRows: 0,
      skippedRows: 0,
      errorRows: 0,
      errorLog: [],
      completedAt: null,
    },
  })
  if (count === 1) return { claimed: true }
  const batch = await db.importBatch.findFirst({ where: { id, organizationId }, select: { status: true } })
  return { claimed: false, status: batch?.status ?? null }
}
