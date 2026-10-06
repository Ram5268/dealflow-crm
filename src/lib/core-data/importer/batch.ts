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

// A short fingerprint (FNV-1a) of what decides how rows are grouped and
// matched: which column feeds which standard field. Not the AI's reasoning,
// confidence or samples, and not custom-field targets: "Back to the import"
// asks the AI again, and those differ on every proposal (a custom field the
// first run created comes back as an existing one).
export function mappingKey(mapping: MappingProposal): string {
  const fields = mapping.mapping
    .flatMap((c) => (c.target.kind === 'standard_field' ? [`${c.column}\u0000${c.target.field}`] : []))
    .sort()
  let h = 0x811c9dc5
  for (const ch of JSON.stringify(fields)) {
    h ^= ch.charCodeAt(0)
    h = Math.imul(h, 0x01000193) >>> 0
  }
  return h.toString(16)
}

// Where a stopped import continues: every row group before `next` is finished
// except those in `partial`, listed as [group index, rows of it already done].
// Only groups still running when it stopped are partial, so at most the
// commit's concurrency (25).
export interface ResumeState {
  next: number
  partial: Array<[number, number]>
}

// Brief 41: an import stopped by the time limit (or the watchdog) records, in
// its row-0 errorLog entry, how far it got and the mapping it used. A re-run
// with the same mapping continues from there instead of row 1.
export function resumePoint(errorLog: unknown, key: string): ResumeState | null {
  if (!Array.isArray(errorLog)) return null
  const stop = errorLog.find((e) => !!e && typeof e === 'object' && (e as { row?: unknown }).row === 0) as
    | { resume?: unknown; mappingKey?: unknown }
    | undefined
  if (!stop || stop.mappingKey !== key) return null
  const r = stop.resume as Partial<ResumeState> | undefined
  const pairs = (p: unknown): p is Array<[number, number]> =>
    Array.isArray(p) && p.every((x) => Array.isArray(x) && x.length === 2 && x.every((n) => Number.isInteger(n) && n >= 0))
  if (!r || !Number.isInteger(r.next) || (r.next as number) <= 0 || !pairs(r.partial)) return null
  return { next: r.next as number, partial: r.partial }
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
