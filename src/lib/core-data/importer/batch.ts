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

// JSON with sorted keys, so a mapping read back from Postgres jsonb (which
// reorders keys) compares equal to the one posted.
function stableJson(value: unknown): string {
  const norm = (v: unknown): unknown =>
    Array.isArray(v)
      ? v.map(norm)
      : v && typeof v === 'object'
        ? Object.fromEntries(Object.keys(v as object).sort().map((k) => [k, norm((v as Record<string, unknown>)[k])]))
        : v
  return JSON.stringify(norm(value))
}

// A short fingerprint of a column mapping (FNV-1a over its stable JSON). The
// rows' grouping, and so a resume point, is only valid for the same mapping.
export function mappingKey(mapping: MappingProposal): string {
  let h = 0x811c9dc5
  for (const ch of stableJson(mapping.mapping)) {
    h ^= ch.charCodeAt(0)
    h = Math.imul(h, 0x01000193) >>> 0
  }
  return h.toString(16)
}

// Brief 41: an import stopped by the time limit records, in its row-0 errorLog
// entry, the first group of rows it didn't finish and the mapping it used. A
// re-run with the same mapping continues from there instead of row 1.
export function resumePoint(errorLog: unknown, key: string): number | null {
  if (!Array.isArray(errorLog)) return null
  const stop = errorLog.find((e) => !!e && typeof e === 'object' && (e as { row?: unknown }).row === 0) as
    | { resumeFromGroup?: unknown; mappingKey?: unknown }
    | undefined
  return typeof stop?.resumeFromGroup === 'number' && stop.resumeFromGroup > 0 && stop.mappingKey === key
    ? stop.resumeFromGroup
    : null
}

// Atomically moves the batch to 'importing' (an UPDATE with the status it was
// read in, in the WHERE), so two clicks or a retried request can't start two
// commits. A stopped import re-run with the same mapping keeps its counts and
// resume point; anything else starts fresh.
export async function claimImportCommit(
  db: PrismaClient,
  id: string,
  organizationId: string,
  mapping: MappingProposal,
): Promise<CommitClaim> {
  const batch = await db.importBatch.findFirst({
    where: { id, organizationId },
    select: { status: true, errorLog: true },
  })
  if (!batch) return { claimed: false, status: null }
  if (!COMMITTABLE.includes(batch.status)) return { claimed: false, status: batch.status }
  const resume = resumePoint(batch.errorLog, mappingKey(mapping)) != null
  const { count } = await db.importBatch.updateMany({
    where: { id, organizationId, status: batch.status },
    data: resume
      ? { status: 'importing', mappingJson: mapping as object, completedAt: null }
      : {
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
  const latest = await db.importBatch.findFirst({ where: { id, organizationId }, select: { status: true } })
  return { claimed: false, status: latest?.status ?? null }
}
