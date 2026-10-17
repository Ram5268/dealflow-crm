import { randomUUID } from 'node:crypto'
import { Prisma, type PrismaClient } from '@prisma/client'
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

// ─── Which run holds an import (Brief 41.1, F1) ──────────────────────────────
// Each claim starts a run with its own id, kept in mappingJson.importRun with a
// heartbeat (the schema is frozen; mappingJson is never sent to the browser).
// Every write a run makes to its batch is conditional on still holding it, so
// a run that stopped responding can't mark a newer run's import failed (which
// let a third run start beside it and import the same homeowners twice) or
// overwrite its counts or its result.

export interface ImportRun {
  id: string
  // The run's heartbeat: set when it is claimed, when it starts, and with
  // every progress write (each 100 rows).
  beatAt: string
}

// After a "stopped responding" failure, the stopped run may still be finishing
// a row until the platform kills it (Vercel's limit is 300 s; the watchdog
// fires at 270 s). A re-run must wait this long after that failure.
export const RERUN_AFTER_WATCHDOG_MS = 60_000
// An import still 'importing' with no heartbeat for this long has no live run
// (a run never lives past 5 minutes): it may be claimed again.
export const STALLED_RUN_MS = 10 * 60_000

export function importRunOf(mappingJson: unknown): ImportRun | null {
  if (!mappingJson || typeof mappingJson !== 'object') return null
  const r = (mappingJson as { importRun?: unknown }).importRun as Partial<ImportRun> | undefined
  return r && typeof r.id === 'string' && typeof r.beatAt === 'string' ? { id: r.id, beatAt: r.beatAt } : null
}

export function withImportRun(mapping: MappingProposal, run: ImportRun): Prisma.InputJsonObject {
  return { ...(mapping as unknown as Prisma.InputJsonObject), importRun: { ...run } }
}

export function newRunId(): string {
  return randomUUID()
}

// Where-clause for a write by run `runId`: it lands only while that run holds
// the batch and the batch is in one of `statuses`.
export function heldBy(id: string, runId: string, statuses: string[] = ['importing']): Prisma.ImportBatchWhereInput {
  return {
    id,
    status: statuses.length === 1 ? statuses[0] : { in: statuses },
    mappingJson: { path: ['importRun', 'id'], equals: runId },
  }
}

// Compare-and-set on the whole mappingJson as it was read (a heartbeat changes it).
export function sameMappingJson(value: Prisma.JsonValue | null): Prisma.JsonNullableFilter<'ImportBatch'> {
  return { equals: value === null ? Prisma.DbNull : (value as Prisma.InputJsonValue) }
}

interface RunState {
  status: string
  mappingJson: unknown
  createdAt: Date
}

// When the import last showed signs of life: its run's heartbeat, or for an
// import claimed before run ids existed, its upload time.
export function lastProgressAt(batch: RunState): number {
  const beat = Date.parse(importRunOf(batch.mappingJson)?.beatAt ?? '')
  return Number.isFinite(beat) ? beat : batch.createdAt.getTime()
}

// 'importing', but no progress for 10 minutes: no run is working on it.
export function isStalled(batch: RunState, now: number): boolean {
  return batch.status === 'importing' && now - lastProgressAt(batch) >= STALLED_RUN_MS
}

// The failure entry a stopped run leaves at row 0 of the errorLog.
interface StopEntry {
  row: 0
  message: string
  resume?: unknown
  mappingKey?: unknown
  // Written by the watchdog: the run may still be finishing a row.
  watchdog?: boolean
}

function stopEntry(errorLog: unknown): StopEntry | null {
  if (!Array.isArray(errorLog)) return null
  const e = errorLog.find((x) => !!x && typeof x === 'object' && (x as { row?: unknown }).row === 0)
  return (e as StopEntry | undefined) ?? null
}

// How long a re-run must still wait after a "stopped responding" failure
// (0 when it may run now). Applies whatever the status: "Back to the import"
// re-proposes the mapping and moves a failed import to mapping_review.
export function rerunWaitMs(batch: { errorLog: unknown; completedAt: Date | null }, now: number): number {
  if (!batch.completedAt || stopEntry(batch.errorLog)?.watchdog !== true) return 0
  return Math.max(0, batch.completedAt.getTime() + RERUN_AFTER_WATCHDOG_MS - now)
}

export async function getImportStatus(db: PrismaClient, id: string, organizationId: string, now: number = Date.now()) {
  const row = await db.importBatch.findFirst({
    where: { id, organizationId },
    select: { ...IMPORT_STATUS_SELECT, mappingJson: true },
  })
  if (!row) return null
  const { mappingJson, ...batch } = row
  const done = batch.importedRows + batch.skippedRows + batch.errorRows
  // Never more than 100%, whatever the counts say.
  const progress =
    batch.totalRows > 0
      ? Math.min(100, Math.round((done / batch.totalRows) * 100))
      : batch.status === 'completed'
        ? 100
        : 0
  return {
    ...batch,
    progress,
    // No live run: the page offers to run it again.
    stalled: isStalled({ status: batch.status, mappingJson, createdAt: batch.createdAt }, now),
    // A run that stopped responding may still be finishing: wait before a re-run.
    retryInSeconds: Math.ceil(rerunWaitMs(batch, now) / 1000),
  }
}

// A commit may start from these. 'failed' allows a retry; a batch that is
// 'importing' (unless stalled) or 'completed' never runs again.
const COMMITTABLE = ['pending', 'mapping_review', 'failed']

export type CommitClaim =
  | { claimed: true; runId: string }
  | { claimed: false; status: string | null; retryInSeconds?: number }

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
  const stop = stopEntry(errorLog)
  if (!stop || stop.mappingKey !== key) return null
  const r = stop.resume as Partial<ResumeState> | undefined
  const pairs = (p: unknown): p is Array<[number, number]> =>
    Array.isArray(p) && p.every((x) => Array.isArray(x) && x.length === 2 && x.every((n) => Number.isInteger(n) && n >= 0))
  if (!r || !Number.isInteger(r.next) || (r.next as number) <= 0 || !pairs(r.partial)) return null
  return { next: r.next as number, partial: r.partial }
}

// Atomically moves the batch to 'importing' under a new run id (an UPDATE
// whose WHERE repeats what was read), so two clicks or a retried request can't
// start two commits. A stopped import re-run with the same mapping keeps its
// counts and resume point; anything else starts fresh.
//
// Brief 41.1: refused for a minute after a "stopped responding" failure (that
// run may still be finishing a row). An import stuck at 'importing' with no
// progress for 10 minutes may be claimed again; it starts fresh, because its
// counts may be ahead of its last recorded resume point (rows it already
// imported are merged, not duplicated).
export async function claimImportCommit(
  db: PrismaClient,
  id: string,
  organizationId: string,
  mapping: MappingProposal,
  opts: { now?: () => number } = {},
): Promise<CommitClaim> {
  const now = (opts.now ?? Date.now)()
  const batch = await db.importBatch.findFirst({
    where: { id, organizationId },
    select: { status: true, errorLog: true, completedAt: true, createdAt: true, mappingJson: true },
  })
  if (!batch) return { claimed: false, status: null }
  const stalled = isStalled(batch, now)
  if (!COMMITTABLE.includes(batch.status) && !stalled) return { claimed: false, status: batch.status }
  const waitMs = rerunWaitMs(batch, now)
  if (waitMs > 0) return { claimed: false, status: batch.status, retryInSeconds: Math.ceil(waitMs / 1000) }
  const resume = !stalled && resumePoint(batch.errorLog, mappingKey(mapping)) != null
  const run: ImportRun = { id: newRunId(), beatAt: new Date(now).toISOString() }
  const { count } = await db.importBatch.updateMany({
    // Unchanged since the read: the same status and stop time, and for a
    // stalled run the same run and heartbeat.
    where: {
      id,
      organizationId,
      status: batch.status,
      completedAt: batch.completedAt,
      ...(stalled ? { mappingJson: sameMappingJson(batch.mappingJson) } : {}),
    },
    data: resume
      ? { status: 'importing', mappingJson: withImportRun(mapping, run), completedAt: null }
      : {
          status: 'importing',
          mappingJson: withImportRun(mapping, run),
          importedRows: 0,
          duplicateRows: 0,
          skippedRows: 0,
          errorRows: 0,
          errorLog: [],
          completedAt: null,
        },
  })
  if (count === 1) return { claimed: true, runId: run.id }
  const latest = await db.importBatch.findFirst({ where: { id, organizationId }, select: { status: true } })
  return { claimed: false, status: latest?.status ?? null }
}
