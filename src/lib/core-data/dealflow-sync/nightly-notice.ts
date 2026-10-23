import type { PrismaClient } from '@prisma/client'
import { DateTime } from 'luxon'
import { prisma } from '@/lib/prisma'
import { IMPORT_SCORING_SOURCE } from '@/lib/core-data/dealflow-score/marker'
import { dealflowRoConfigured, roQuery } from './ro-client'
import { MAX_BATCH_AGE_MS, fetchNewestList } from './sync'
import { countBatchMapping, refuseBatch } from './write'
import { logger } from '@/lib/logger'

// ─────────────────────────────────────────────────────────────────────────────
// Brief 47 (PR 6): the Queue page's notice when DealFlow's newest nightly,
// within the last 2 days, was stopped by a safety check or ran without our
// values. The notice is an engineering precaution (the planner, Brief 47,
// 2026-10-18), so a quiet switch-off doesn't go unnoticed:
//   • refused  = Brief 47 PR 1's checks: the scoring size check refused the
//     night (NIGHTLY_SCORING_REFUSED), or the call-list step would have
//     written an empty list and kept yesterday's (CALL_QUEUE_BUILD_REFUSED);
//   • rollback = Brief 44's automatic switch-off: the night's NIGHTLY_SCORING
//     row says ourEstimates.rolledBack = true.
// The action names are literal strings, written by the nightly, Brief 47 PR 1
// (the two _REFUSED ones) and by DealFlow's existing nightly steps (the others).
//
// One statement through roQuery (BEGIN READ ONLY … ROLLBACK). It returns one
// row holding a code and nothing else: no ids, no times, no details beyond the
// rolledBack flag it tests. AuditLog."createdAt" is timestamp without time
// zone holding UTC, so the window is measured from (now() AT TIME ZONE 'UTC'),
// never a bare now() (which Postgres would compare in the session's zone).
//
// No organization filter. The morning copy no longer reads that way: since
// Brief 50 PR 11 it reads only the DealFlow organization with the CRM
// organization's slug (RO_SQL and RUN_INFO_SQL in sync.ts take it as $1), and
// so does the refused-copy line below (NEWEST_LIST_SQL). This statement was
// left as Brief 47 wrote it: DealFlow holds one organization (slug
// dealflow-ryan), its nightly writes every row under it, and the CRM's own
// organization id means nothing in DealFlow's database.
// ─────────────────────────────────────────────────────────────────────────────

export type NightlyNoticeCode = 'refused' | 'rollback'

export const NIGHTLY_NOTICE_TEXT: Record<NightlyNoticeCode, string> = {
  refused: "Last night's matching was stopped by a safety check. You're seeing yesterday's call list.",
  rollback: "Last night's matching ran without DealFlow's values (a safety check turned them off). Ask Claude to look.",
}

// CONTRACT.md "PR 6's rule", within the last 2 days:
//   refused if the newest of NIGHTLY_SCORING / NIGHTLY_SCORING_REFUSED is the
//   refusal, or the newest of CALL_QUEUE_BUILD / CALL_QUEUE_BUILD_REFUSED is;
//   else rollback if the newest NIGHTLY_SCORING rolled our values back;
//   else nothing. Older rows never count. Two rows stamped the same moment
//   (not expected: a refused night writes no NIGHTLY_SCORING) count the
//   refusal as the newer one, the safer side.
export const NIGHTLY_NOTICE_SQL = `
  WITH recent AS (
    SELECT "action", "createdAt", "detailsJson"->'ourEstimates'->>'rolledBack' AS rolled_back
    FROM "AuditLog"
    WHERE "action" IN ('NIGHTLY_SCORING', 'NIGHTLY_SCORING_REFUSED', 'CALL_QUEUE_BUILD', 'CALL_QUEUE_BUILD_REFUSED')
      AND "createdAt" > (now() AT TIME ZONE 'UTC') - interval '2 days'
  ),
  scoring AS (
    SELECT "action", rolled_back FROM recent
    WHERE "action" IN ('NIGHTLY_SCORING', 'NIGHTLY_SCORING_REFUSED')
    ORDER BY "createdAt" DESC, ("action" = 'NIGHTLY_SCORING_REFUSED') DESC LIMIT 1
  ),
  call_list AS (
    SELECT "action" FROM recent
    WHERE "action" IN ('CALL_QUEUE_BUILD', 'CALL_QUEUE_BUILD_REFUSED')
    ORDER BY "createdAt" DESC, ("action" = 'CALL_QUEUE_BUILD_REFUSED') DESC LIMIT 1
  )
  SELECT CASE
    WHEN (SELECT "action" FROM scoring) = 'NIGHTLY_SCORING_REFUSED'
      OR (SELECT "action" FROM call_list) = 'CALL_QUEUE_BUILD_REFUSED' THEN 'refused'
    WHEN (SELECT "action" FROM scoring) = 'NIGHTLY_SCORING'
      AND (SELECT rolled_back FROM scoring) = 'true' THEN 'rollback'
  END AS notice
`

// Pure: the statement's row → the banner's sentence, or null for no banner.
export function nightlyNoticeText(row: { notice?: unknown } | null | undefined): string | null {
  const code = row?.notice
  return code === 'refused' || code === 'rollback' ? NIGHTLY_NOTICE_TEXT[code] : null
}

// The longest the notice waits for DealFlow. The page shows the Queue without
// waiting (Suspense), but a refresh of the same page waits for every boundary,
// so a slow or unreachable DealFlow (the pool's connect timeout is 8 s) must
// not hold it up: past this, there is simply no notice [engineering precaution].
export const NIGHTLY_NOTICE_WAIT_MS = 2_500

// The banner's sentence, or null. Never throws: with no read-only setting, in
// stub mode (no DealFlow, as the health probe), when the read fails or takes
// longer than waitMs, there is no banner and the Queue page is unaffected. The
// log line carries an error code only: no address, no SQL, no values.
export async function readNightlyNotice(waitMs = NIGHTLY_NOTICE_WAIT_MS): Promise<string | null> {
  if (process.env.DEALFLOW_SYNC_STUB === '1') return null
  if (!dealflowRoConfigured()) {
    logger.warn("Queue notice: DealFlow's read-only connection isn't set up, so no last-night notice")
    return null
  }
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    const read = roQuery<{ notice: string | null }>(NIGHTLY_NOTICE_SQL)
    // An abandoned read still ends on its own (roQuery releases its client);
    // a failure after the wait is ignored, never thrown.
    read.catch(() => undefined)
    const timedOut = new Promise<'timeout'>((resolve) => {
      timer = setTimeout(() => resolve('timeout'), waitMs)
    })
    const outcome = await Promise.race([read, timedOut])
    if (outcome === 'timeout') {
      logger.warn({ code: 'timeout' }, "Queue notice: DealFlow's last night took too long to read, so no notice")
      return null
    }
    return nightlyNoticeText(outcome[0])
  } catch (err) {
    const code = (err as { code?: unknown } | null)?.code
    logger.warn({ code: typeof code === 'string' ? code : null }, "Queue notice: couldn't read DealFlow's last night, so no notice")
    return null
  } finally {
    clearTimeout(timer)
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Brief 50 (PR 19): the Queue's line when this morning's copy from DealFlow was
// refused [Ryan's no-babysitting rule, 2026-10-18: checks show up in the
// product]. The 7:00 copy (run.ts) refuses a list that reaches no CRM lead, or
// fewer than half the leads the last copy reached, and writes nothing
// (write.ts refuseBatch; the check is an engineering precaution, Brief 50 PR
// 11). Nothing records a refusal (Revision 2 adds no table or column), so the
// line is worked out from what the CRM and DealFlow already hold:
//   • the last copy that went through: the CRM's newest morning signal, its
//     time and DealFlow run id (LAST_COPY_SQL);
//   • the last scheduled copy: 11:00 UTC every day (vercel.json; 7:00 am EDT,
//     6:00 am EST), counted once it has had COPY_GRACE_MS to start and finish
//     (Vercel's Hobby plan may start it at any minute of that hour);
//   • only when the last copy that went through is older than the last
//     scheduled one (that copy wrote nothing), DealFlow's newest list is read
//     (sync.ts NEWEST_LIST_SQL, through the read-only client) and put through
//     the copy's own check (countBatchMapping and refuseBatch: the same code
//     and SQL the copy runs). Refused → the line: N = the leads that list
//     reaches, M = the leads the last copy reached, and the date of the order
//     the Queue still shows (the last copy's, New York time).
// So the line shows only while a refused copy is the newest copy attempt: a
// later copy that goes through holds DealFlow's newest list, so no line; a
// list skipped as too old (sync.ts MAX_BATCH_AGE_MS, 36 h) or a copy that
// couldn't read DealFlow shows no line (the list didn't look wrong); and a
// list DealFlow made after the last scheduled copy isn't judged before the
// next one has had its chance. DealFlow keeps only its newest list, so N is
// that list's, counted when the page loads, and after a refused morning the
// line goes once DealFlow's next list looks right (the next copy takes it). A
// normal morning costs one small CRM read and no DealFlow read at all.
// ─────────────────────────────────────────────────────────────────────────────

/** The hour (UTC) vercel.json runs the copy at: "0 11 * * *". */
export const COPY_HOUR_UTC = 11
/**
 * How long after 11:00 UTC the Queue waits before judging that day's copy.
 * Vercel's Hobby plan starts a daily cron at any minute of its hour (11:00 to
 * 11:59 UTC), and the route may then run for up to 300 s (maxDuration), so a
 * copy that is merely late is over by 12:05 UTC; 70 minutes covers that with
 * room. Until then the Queue neither shows the line nor reads DealFlow
 * [engineering precaution].
 */
export const COPY_GRACE_MS = 70 * 60_000
const DAY_MS = 86_400_000

/** The newest scheduled morning copy that has had COPY_GRACE_MS to finish, at or before `now`. */
export function lastScheduledCopy(now: Date): Date {
  const t = now.getTime() - COPY_GRACE_MS
  const d = new Date(t)
  const today = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), COPY_HOUR_UTC)
  return new Date(today <= t ? today : today - DAY_MS)
}

// $1 = organizationId. The organization's slug, and its newest morning
// signal's time and DealFlow run id: the last copy that went through (every
// row one copy writes carries the same time and run). An upload's scoring
// rows don't count (dealflow-score/marker.ts). copiedAt is null before the
// first copy; no row for an unknown organization.
export const LAST_COPY_SQL = `
  SELECT o."slug", s."syncedAt" AS "copiedAt", s."dealflowRawJson"->>'generationRunId' AS "runId"
  FROM "Organization" o
  LEFT JOIN LATERAL (
    SELECT x."syncedAt", x."dealflowRawJson" FROM "DealFlowDerivedSignal" x
    WHERE x."organizationId" = o."id"
      AND (x."dealflowRawJson"->>'source') IS DISTINCT FROM '${IMPORT_SCORING_SOURCE}'
    ORDER BY x."syncedAt" DESC LIMIT 1
  ) s ON true
  WHERE o."id" = $1`

export interface CopyRefusal {
  reached: number // N: the organization's leads DealFlow's newest list reaches
  usual: number // M: the organization's leads the last copy reached
  copiedAt: Date // when the last copy went through: the order the Queue still shows
}

/**
 * The refused copy the Queue shows, or null (see above). Throws when a read
 * fails; readCopyRefusal turns that into no line.
 */
export async function findCopyRefusal(organizationId: string, now: Date, db: PrismaClient = prisma): Promise<CopyRefusal | null> {
  const [last] = await db.$queryRawUnsafe<{ slug: string; copiedAt: Date | null; runId: string | null }[]>(LAST_COPY_SQL, organizationId)
  // No earlier copy: no order for the Queue to "still show". (A first copy
  // that matches nobody is refused all the same; the cron's 409 says so.)
  if (!last?.copiedAt) return null
  const due = lastScheduledCopy(now)
  // The last scheduled copy went through, or DealFlow's new list waits for the next one.
  if (last.copiedAt.getTime() >= due.getTime()) return null
  if (!dealflowRoConfigured()) return null
  const list = await fetchNewestList(last.slug, last.runId, { statementTimeoutMs: NIGHTLY_NOTICE_WAIT_MS })
  // DealFlow has no list, or the CRM already holds its newest one.
  if (!list?.sellers) return null
  // Already too old when the copy ran: skipped as stale, not refused as wrong.
  if (due.getTime() - Date.parse(list.generatedAt) > MAX_BATCH_AGE_MS) return null
  const mapping = await countBatchMapping(organizationId, list.sellers, db)
  if (!refuseBatch(mapping)) return null
  return { reached: mapping.mappedLeads, usual: mapping.lastCopyLeads, copiedAt: last.copiedAt }
}

const NY = 'America/New_York'

/** The line, word for word as Brief 50 Revision 2 gives it; the date in New York time ("Oct 23"; with the year when it isn't this one). */
export function copyRefusalText({ reached, usual, copiedAt }: CopyRefusal, now: Date = new Date()): string {
  const day = DateTime.fromJSDate(copiedAt).setZone(NY).setLocale('en-US')
  const date = day.toFormat(day.hasSame(DateTime.fromJSDate(now).setZone(NY), 'year') ? 'LLL d' : 'LLL d, yyyy')
  const count = (n: number) => n.toLocaleString('en-US')
  return (
    `This morning's ranking from DealFlow looked wrong (it reached ${count(reached)} of your usual ${count(usual)} sellers), ` +
    `so the Queue still shows ${date}'s order.`
  )
}

// The line, or null. Never throws, and waits at most waitMs (the nightly
// notice's 2.5 s; the page streams it in on its own, so the Queue never
// waits): in stub mode, with no read-only setting, when a read fails or takes
// longer, there is no line. The log line carries an error code only: no
// address, no SQL, no values.
export async function readCopyRefusal(
  organizationId: string,
  opts: { now?: Date; waitMs?: number; db?: PrismaClient } = {}
): Promise<string | null> {
  if (process.env.DEALFLOW_SYNC_STUB === '1') return null
  const now = opts.now ?? new Date()
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    const work = findCopyRefusal(organizationId, now, opts.db ?? prisma)
    // An abandoned check still ends on its own (reads only); a failure after
    // the wait is ignored, never thrown.
    work.catch(() => undefined)
    const timedOut = new Promise<'timeout'>((resolve) => {
      timer = setTimeout(() => resolve('timeout'), opts.waitMs ?? NIGHTLY_NOTICE_WAIT_MS)
    })
    const outcome = await Promise.race([work, timedOut])
    if (outcome === 'timeout') {
      logger.warn({ code: 'timeout' }, "Queue notice: checking this morning's copy took too long, so no line")
      return null
    }
    return outcome ? copyRefusalText(outcome, now) : null
  } catch (err) {
    const code = (err as { code?: unknown } | null)?.code
    logger.warn({ code: typeof code === 'string' ? code : null }, "Queue notice: couldn't check this morning's copy, so no line")
    return null
  } finally {
    clearTimeout(timer)
  }
}
