// Brief 45 (PR F): new people ranked within minutes (CONTRACT §7, the CRM's
// side). The import progress page calls POST /api/imports/[id]/score again
// and again once an upload has finished; each call handles ONE chunk:
//   1. the import must be completed, not yet scored, with no recorded failure;
//   2. the next ≤ 500 of its NEW leads that still need scoring, in id order
//      after the page's cursor ("new" = source import:<id> and created no
//      earlier than the upload: a merge re-stamps source on people who were
//      already in the CRM, and they keep the rank they have);
//   3. a fresh one-time token; only its SHA-256 is stored on the import, for
//      the length of this one request [engineering precaution];
//   4. DealFlow scores them (POST /api/crm/score-import) and answers;
//   5. only those leads' fields and signals are written (write.ts);
//   6. when no chunk is left: dealflowScoredAt is set and the hash cleared.
// Any failure (DealFlow unreachable, a 5xx, no answer in 280 s, a refusal, an
// answer that can't be read or saved) stops it: the plain-English reason goes
// in dealflowScoreError, the import itself stays completed, and the new people
// show "scoring…" until the morning update ranks them [brief §5.8].
//
// Two pages at once (a reload while a chunk is out): each request stores its
// own token, so the older one may be refused or fail. When the stored hash is
// no longer this request's, that is a lost race, not a failure: the page is
// told to retry. Writes are idempotent, so a chunk scored twice is harmless.
import type { PrismaClient } from '@prisma/client'
import { prisma } from '@/lib/prisma'
import { logger } from '@/lib/logger'
import { HttpError } from '@/lib/shared/http'
import { SCORE_ERROR } from './messages'
import { dealflowAppBase, newScoreToken, requestDealflowScores, type DealflowOutcome, type ScoreResponse } from './request'
import { writeBackScores } from './write'

/** DealFlow takes at most 500 leads per request (PR E). */
export const SCORE_CHUNK_SIZE = 500
/**
 * DealFlow accepts a token for 60 minutes after the import finished; a minute
 * is kept back for the two servers' clocks and the time a request travels.
 */
export const SCORE_WINDOW_MS = 59 * 60_000
// The ids DealFlow accepts (PR E request.ts). The importer's ids always are.
const DEALFLOW_ID = /^[A-Za-z0-9_-]{1,64}$/

export interface ScoreChunkResult {
  /** Stop calling: everyone was sent, or the scoring stopped (see error). */
  done: boolean
  /** The cursor for the next call. */
  next: string | null
  /** Leads written this call (ranked, or looked at with no buyer match). */
  scored: number
  /** Of those, the ones DealFlow left unranked. */
  notRanked: number
  /** Leads DealFlow passed over this call; they are left untouched. */
  skipped: { noMojoId: number; notCopied: number; other: number }
  /** New people still to send after `next`. */
  remaining: number
  /** Another page's request overlapped this one: call again shortly, same cursor. */
  retry?: true
  /** Why the scoring stopped (plain English). The import itself is complete. */
  error?: string
}

export interface ScoreDeps {
  db?: PrismaClient
  fetch?: typeof fetch
  now?: () => Date
  /** DealFlow's address; default dealflowAppBase(). null: no address, don't call. */
  baseUrl?: string | null
  timeoutMs?: number
  chunkSize?: number
}

const STATE = { status: true, completedAt: true, dealflowScoredAt: true, dealflowScoreError: true, dealflowScoreTokenHash: true } as const
type State = { status: string; completedAt: Date | null; dealflowScoredAt: Date | null; dealflowScoreError: string | null; dealflowScoreTokenHash: string | null }

const NO_SKIPS = { noMojoId: 0, notCopied: 0, other: 0 }
const result = (over: Partial<ScoreChunkResult>): ScoreChunkResult => ({
  done: true, next: null, scored: 0, notRanked: 0, skipped: { ...NO_SKIPS }, remaining: 0, ...over,
})

// Nothing (more) to do for this import, or null to go on.
function settled(b: State): ScoreChunkResult | null {
  if (b.status !== 'completed' || b.dealflowScoredAt) return result({})
  if (b.dealflowScoreError) return result({ error: b.dealflowScoreError })
  return null
}

// The import's new leads that still need scoring, in id order after `after`
// (the importer's ids, compared byte by byte so the order never depends on
// the database's collation).
async function nextChunk(db: PrismaClient, importId: string, after: string | null, size: number): Promise<string[]> {
  const rows = await db.$queryRaw<{ id: string }[]>`
    SELECT l.id FROM "ImportBatch" b
    JOIN "Lead" l ON l."organizationId" = b."organizationId" AND l.source = 'import:' || b.id AND l."createdAt" >= b."createdAt"
    WHERE b.id = ${importId}
      AND (l."dealflowSignalSyncedAt" IS NULL OR l."dealflowSignalSyncedAt" < b."completedAt")
      AND (${after}::text IS NULL OR l.id COLLATE "C" > ${after}::text)
    ORDER BY l.id COLLATE "C"
    LIMIT ${size}`
  return rows.map((r) => r.id)
}

async function remainingAfter(db: PrismaClient, importId: string, after: string): Promise<number> {
  const [r] = await db.$queryRaw<{ n: number }[]>`
    SELECT count(*)::int AS n FROM "ImportBatch" b
    JOIN "Lead" l ON l."organizationId" = b."organizationId" AND l.source = 'import:' || b.id AND l."createdAt" >= b."createdAt"
    WHERE b.id = ${importId}
      AND (l."dealflowSignalSyncedAt" IS NULL OR l."dealflowSignalSyncedAt" < b."completedAt")
      AND l.id COLLATE "C" > ${after}::text`
  return r?.n ?? 0
}

const readState = (db: PrismaClient, importId: string) =>
  db.importBatch.findUnique({ where: { id: importId }, select: STATE }) as Promise<State | null>

// Every new person was sent: mark the import scored and clear the hash.
async function finish(db: PrismaClient, importId: string, now: Date, counts: Partial<ScoreChunkResult>): Promise<ScoreChunkResult> {
  const { count } = await db.importBatch.updateMany({
    where: { id: importId, dealflowScoredAt: null, dealflowScoreError: null },
    data: { dealflowScoredAt: now, dealflowScoreTokenHash: null },
  })
  if (count === 0) {
    const b = await readState(db, importId)
    if (b?.dealflowScoreError) return result({ ...counts, error: b.dealflowScoreError })
  }
  return result(counts)
}

// Records why the scoring stopped (and clears the hash). With `hash`, only
// while this request's token is still the stored one; otherwise another page
// took over and this is a lost race.
async function stop(db: PrismaClient, importId: string, hash: string | null, message: string, after: string | null): Promise<ScoreChunkResult> {
  const { count } = await db.importBatch.updateMany({
    where: { id: importId, dealflowScoredAt: null, dealflowScoreError: null, ...(hash ? { dealflowScoreTokenHash: hash } : {}) },
    data: { dealflowScoreError: message, dealflowScoreTokenHash: null },
  })
  if (count === 1) return result({ error: message })
  const b = await readState(db, importId)
  return (b && settled(b)) ?? result({ done: false, next: after, retry: true })
}

function messageFor(outcome: Extract<DealflowOutcome, { ok: false }>): string {
  switch (outcome.failure) {
    case 'unreachable':
      return SCORE_ERROR.unreachable
    case 'timeout':
      return SCORE_ERROR.timeout
    case 'server':
      return SCORE_ERROR.server
    case 'unreadable':
      return SCORE_ERROR.unreadable
    case 'refused':
      return outcome.code === 'expired' ? SCORE_ERROR.expired : SCORE_ERROR.refused
  }
}

// Leads of the chunk not written, by DealFlow's reason.
function skips(ids: string[], written: ReadonlySet<string>, response: ScoreResponse | null): ScoreChunkResult['skipped'] {
  const reason = new Map((response?.skipped ?? []).map((s) => [s.crmLeadId, s.reason]))
  const out = { ...NO_SKIPS }
  for (const id of ids) {
    if (written.has(id)) continue
    const r = reason.get(id)
    if (r === 'no_mojo_id') out.noMojoId++
    else if (r === 'not_copied') out.notCopied++
    else out.other++
  }
  return out
}

/** One chunk of an upload's new people: sent to DealFlow, answers written. */
export async function scoreNextChunk(
  organizationId: string,
  importId: string,
  after: string | null,
  deps: ScoreDeps = {},
): Promise<ScoreChunkResult> {
  const db = deps.db ?? prisma
  const now = deps.now ?? (() => new Date())
  const batch = (await db.importBatch.findFirst({ where: { id: importId, organizationId }, select: STATE })) as State | null
  if (!batch) throw new HttpError(404, 'Import not found.')
  const done = settled(batch)
  if (done) return done

  const ids = await nextChunk(db, importId, after, deps.chunkSize ?? SCORE_CHUNK_SIZE)
  if (ids.length === 0) return finish(db, importId, now(), {})
  if (!batch.completedAt || now().getTime() - batch.completedAt.getTime() >= SCORE_WINDOW_MS) {
    return stop(db, importId, null, SCORE_ERROR.expired, after)
  }
  const baseUrl = 'baseUrl' in deps ? deps.baseUrl : dealflowAppBase()
  if (!baseUrl) {
    logger.warn({ importId }, 'import scoring: DEALFLOW_APP_BASE_URL is not set outside production; not calling DealFlow')
    return stop(db, importId, null, SCORE_ERROR.unreachable, after)
  }

  const send = ids.filter((id) => DEALFLOW_ID.test(id))
  const last = ids[ids.length - 1]
  let written: ReadonlySet<string> = new Set()
  let notRanked = 0
  let response: ScoreResponse | null = null
  if (send.length > 0) {
    const { token, hash } = newScoreToken()
    const claim = await db.importBatch.updateMany({
      where: { id: importId, status: 'completed', dealflowScoredAt: null, dealflowScoreError: null },
      data: { dealflowScoreTokenHash: hash },
    })
    if (claim.count === 0) {
      const b = await readState(db, importId)
      return (b && settled(b)) ?? result({})
    }
    const outcome = await requestDealflowScores({ baseUrl, importId, token, leadIds: send }, { fetch: deps.fetch, timeoutMs: deps.timeoutMs })
    if (!outcome.ok) {
      const b = await readState(db, importId)
      const over = b && settled(b)
      if (over) return over
      // Another page stored its own token meanwhile: a lost race, not a failure.
      if (b?.dealflowScoreTokenHash !== hash) return result({ done: false, next: after, retry: true })
      logger.warn({ importId, failure: outcome.failure, status: outcome.status, code: outcome.code, leads: send.length }, 'import scoring stopped')
      return stop(db, importId, hash, messageFor(outcome), after)
    }
    response = outcome.response
    try {
      const saved = await writeBackScores(db, organizationId, importId, response, new Set(send), now())
      written = saved.written
      notRanked = saved.notRanked
    } catch (err) {
      logger.warn({ importId, err: err instanceof Error ? err.message : String(err) }, 'import scoring: the answer could not be saved')
      return stop(db, importId, hash, SCORE_ERROR.save, after)
    }
    // The token has done its one job.
    await db.importBatch.updateMany({ where: { id: importId, dealflowScoreTokenHash: hash }, data: { dealflowScoreTokenHash: null } })
  }

  const counts = { scored: written.size, notRanked, skipped: skips(ids, written, response) }
  logger.info({ importId, sent: send.length, ...counts }, 'import scoring: chunk written')
  const remaining = await remainingAfter(db, importId, last)
  if (remaining === 0) return finish(db, importId, now(), counts)
  return result({ ...counts, done: false, next: last, remaining })
}
