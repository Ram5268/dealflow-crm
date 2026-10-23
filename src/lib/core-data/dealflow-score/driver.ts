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
//
// Brief 50 (PR 7, open item 6.12): people ranked while DealFlow's 5:00 am run
// may have been going (nightly.ts) are ranked once more after it has certainly
// ended. The first ranking ends as before, saying when to ask again (waitMs).
// Asked again then ({ retry: true }), the CRM reopens the upload once (clears
// dealflowScoredAt, which DealFlow requires) and the same chunk-by-chunk pass
// runs again, now also taking those people; when it ends, dealflowScoredAt is
// past the 7-minute mark, so it can't be reopened again. A failure during that
// second ranking ends it quietly: everyone keeps their first ranking.
import { Prisma, type PrismaClient } from '@prisma/client'
import { prisma } from '@/lib/prisma'
import { logger } from '@/lib/logger'
import { HttpError } from '@/lib/shared/http'
import { SCORE_ERROR } from './messages'
import { NIGHTLY_RISK_FROM_UTC, NIGHTLY_RISK_UNTIL_UTC, NIGHTLY_SAFE_AFTER_MS } from './nightly'
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
  /**
   * Brief 50 PR 7, with done: some of these people were ranked while
   * DealFlow's nightly run may have been going. Ask again with { retry: true }
   * after this many milliseconds for their second ranking.
   */
  waitMs?: number
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

// The import's new leads: those it stamped (source import:<id>) and created.
const NEW_LEADS = Prisma.sql`"ImportBatch" b
    JOIN "Lead" l ON l."organizationId" = b."organizationId" AND l.source = 'import:' || b.id AND l."createdAt" >= b."createdAt"`
// Not yet written since the upload finished.
const UNSCORED = Prisma.sql`(l."dealflowSignalSyncedAt" IS NULL OR l."dealflowSignalSyncedAt" < b."completedAt")`
// Brief 50 PR 7: written by this upload's ranking while DealFlow's nightly run
// may have been going (nightly.ts): after the upload finished, before every
// run that could have missed them had ended, at a time of day (the column is
// UTC) inside the run's hour. A second ranking moves the time past that point.
const RANKED_DURING_RUN = Prisma.sql`(l."dealflowSignalSyncedAt" >= b."completedAt"
      AND l."dealflowSignalSyncedAt" < b."completedAt" + ${NIGHTLY_SAFE_AFTER_MS}::int * interval '1 millisecond'
      AND l."dealflowSignalSyncedAt"::time >= ${NIGHTLY_RISK_FROM_UTC}::time
      AND l."dealflowSignalSyncedAt"::time < ${NIGHTLY_RISK_UNTIL_UTC}::time)`
// What a pass sends: everyone not yet written; once every run that could have
// missed them is over, also the people ranked during one.
const toSend = (afterRun: boolean) => (afterRun ? Prisma.sql`(${UNSCORED} OR ${RANKED_DURING_RUN})` : UNSCORED)

interface ChunkLead {
  id: string
  /** Already ranked once since the upload (sent again for the second ranking). */
  again: boolean
}

// The import's new leads to send, in id order after `after` (the importer's
// ids, compared byte by byte so the order never depends on the database's
// collation).
async function nextChunk(db: PrismaClient, importId: string, after: string | null, size: number, afterRun: boolean): Promise<ChunkLead[]> {
  return db.$queryRaw<ChunkLead[]>`
    SELECT l.id, COALESCE(l."dealflowSignalSyncedAt" >= b."completedAt", false) AS again FROM ${NEW_LEADS}
    WHERE b.id = ${importId}
      AND ${toSend(afterRun)}
      AND (${after}::text IS NULL OR l.id COLLATE "C" > ${after}::text)
    ORDER BY l.id COLLATE "C"
    LIMIT ${size}`
}

async function remainingAfter(db: PrismaClient, importId: string, after: string, afterRun: boolean): Promise<number> {
  const [r] = await db.$queryRaw<{ n: number }[]>`
    SELECT count(*)::int AS n FROM ${NEW_LEADS}
    WHERE b.id = ${importId}
      AND ${toSend(afterRun)}
      AND l.id COLLATE "C" > ${after}::text`
  return r?.n ?? 0
}

// Brief 50 PR 7: how many of the upload's people still wait for a second ranking.
async function rankedDuringRun(db: PrismaClient, importId: string): Promise<number> {
  const [r] = await db.$queryRaw<{ n: number }[]>`
    SELECT count(*)::int AS n FROM ${NEW_LEADS}
    WHERE b.id = ${importId} AND ${RANKED_DURING_RUN}`
  return r?.n ?? 0
}

const safeAfter = (completedAt: Date) => completedAt.getTime() + NIGHTLY_SAFE_AFTER_MS

const readState = (db: PrismaClient, importId: string) =>
  db.importBatch.findUnique({ where: { id: importId }, select: STATE }) as Promise<State | null>

// Every new person was sent: mark the import scored and clear the hash. If
// some were ranked while DealFlow's nightly run may have been going, say when
// to ask for their second ranking (Brief 50 PR 7).
async function finish(db: PrismaClient, importId: string, now: Date, counts: Partial<ScoreChunkResult>): Promise<ScoreChunkResult> {
  const { count } = await db.importBatch.updateMany({
    where: { id: importId, dealflowScoredAt: null, dealflowScoreError: null },
    data: { dealflowScoredAt: now, dealflowScoreTokenHash: null },
  })
  const b = await readState(db, importId)
  if (count === 0 && b?.dealflowScoreError) return result({ ...counts, error: b.dealflowScoreError })
  const wait = b?.completedAt ? safeAfter(b.completedAt) - now.getTime() : 0
  if (count === 1 && wait > 0 && (await rankedDuringRun(db, importId)) > 0) return result({ ...counts, waitMs: wait })
  return result(counts)
}

// Brief 50 PR 7: the second ranking ends quietly when DealFlow fails during
// it. Everyone keeps their first ranking, the import page still says
// "Ranked: done", and it isn't tried again.
async function endQuietly(db: PrismaClient, importId: string, hash: string | null, now: Date, after: string | null): Promise<ScoreChunkResult> {
  const { count } = await db.importBatch.updateMany({
    where: { id: importId, dealflowScoredAt: null, dealflowScoreError: null, ...(hash ? { dealflowScoreTokenHash: hash } : {}) },
    data: { dealflowScoredAt: now, dealflowScoreTokenHash: null },
  })
  if (count === 1) return result({})
  const b = await readState(db, importId)
  return (b && settled(b)) ?? result({ done: false, next: after, retry: true })
}

/**
 * Brief 50 PR 7: "is the second ranking due?" Owed when the first ranking
 * ended (before the 7-minute mark) and some people were ranked while
 * DealFlow's nightly run may have been going. Too early: when to ask again.
 * Due: the upload is reopened, once, and its pass starts again. Otherwise (not
 * owed, already done, past DealFlow's hour, another page reopened it): done,
 * with nothing sent or changed.
 */
async function reopenForSecondRanking(db: PrismaClient, batch: State, importId: string, now: Date): Promise<'reopened' | ScoreChunkResult> {
  const scoredAt = batch.dealflowScoredAt
  if (batch.status !== 'completed' || batch.dealflowScoreError || !scoredAt || !batch.completedAt) return result({})
  const safe = safeAfter(batch.completedAt)
  if (scoredAt.getTime() >= safe || now.getTime() - batch.completedAt.getTime() >= SCORE_WINDOW_MS) return result({})
  if ((await rankedDuringRun(db, importId)) === 0) return result({})
  if (now.getTime() < safe) return result({ waitMs: safe - now.getTime() })
  const { count } = await db.importBatch.updateMany({
    where: { id: importId, dealflowScoredAt: scoredAt, dealflowScoreError: null },
    data: { dealflowScoredAt: null },
  })
  if (count === 0) return result({})
  logger.info({ importId }, "import scoring: ranking again the people ranked during DealFlow's nightly run")
  return 'reopened'
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

/**
 * One chunk of an upload's new people: sent to DealFlow, answers written.
 * With { retry: true } (Brief 50 PR 7): only "is the second ranking due?";
 * when it is, the upload is reopened and its first chunk sent (the caller
 * then goes on with `next` as usual).
 */
export async function scoreNextChunk(
  organizationId: string,
  importId: string,
  after: string | null,
  deps: ScoreDeps = {},
  opts: { retry?: boolean } = {},
): Promise<ScoreChunkResult> {
  const db = deps.db ?? prisma
  const now = deps.now ?? (() => new Date())
  const batch = (await db.importBatch.findFirst({ where: { id: importId, organizationId }, select: STATE })) as State | null
  if (!batch) throw new HttpError(404, 'Import not found.')
  if (opts.retry) {
    const due = await reopenForSecondRanking(db, batch, importId, now())
    if (due !== 'reopened') return due
    batch.dealflowScoredAt = null
    after = null
  }
  const done = settled(batch)
  if (done) return done

  const afterRun = !!batch.completedAt && now().getTime() >= safeAfter(batch.completedAt)
  const chunk = await nextChunk(db, importId, after, deps.chunkSize ?? SCORE_CHUNK_SIZE, afterRun)
  if (chunk.length === 0) return finish(db, importId, now(), {})
  const ids = chunk.map((l) => l.id)
  // Brief 50 PR 7: a chunk carrying people already ranked once belongs to the
  // second ranking, which ends quietly if it can't be done.
  const second = chunk.some((l) => l.again)
  const fail = (hash: string | null, message: string) => (second ? endQuietly(db, importId, hash, now(), after) : stop(db, importId, hash, message, after))
  if (!batch.completedAt || now().getTime() - batch.completedAt.getTime() >= SCORE_WINDOW_MS) {
    return fail(null, SCORE_ERROR.expired)
  }
  const baseUrl = 'baseUrl' in deps ? deps.baseUrl : dealflowAppBase()
  if (!baseUrl) {
    logger.warn({ importId }, "import scoring: no DEALFLOW_APP_BASE_URL and this isn't production; not calling DealFlow")
    return fail(null, SCORE_ERROR.noAddress)
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
      logger.warn({ importId, failure: outcome.failure, status: outcome.status, code: outcome.code, leads: send.length, second }, 'import scoring stopped')
      return fail(hash, messageFor(outcome))
    }
    response = outcome.response
    try {
      const saved = await writeBackScores(db, organizationId, importId, response, new Set(send), now())
      written = saved.written
      notRanked = saved.notRanked
    } catch (err) {
      logger.warn({ importId, err: err instanceof Error ? err.message : String(err), second }, 'import scoring: the answer could not be saved')
      return fail(hash, SCORE_ERROR.save)
    }
    // The token has done its one job.
    await db.importBatch.updateMany({ where: { id: importId, dealflowScoreTokenHash: hash }, data: { dealflowScoreTokenHash: null } })
  }

  const counts = { scored: written.size, notRanked, skipped: skips(ids, written, response) }
  logger.info({ importId, sent: send.length, ...counts }, 'import scoring: chunk written')
  const remaining = await remainingAfter(db, importId, last, afterRun)
  if (remaining === 0) return finish(db, importId, now(), counts)
  return result({ ...counts, done: false, next: last, remaining })
}
