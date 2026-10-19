import { dealflowRoConfigured, roQuery } from './ro-client'
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
// No organization filter, matching the sync (RO_SQL and RUN_INFO_SQL in
// sync.ts read DealFlow's newest rows without one): DealFlow holds one
// organization (slug dealflow-ryan), its nightly writes every row under it,
// and the CRM's own organization id means nothing in DealFlow's database.
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
