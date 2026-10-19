// Brief 50 (PR 7, open item 6.12): an upload ranked while DealFlow's 5:00 am
// run is going.
//
// What goes wrong: DealFlow's nightly run first copies every CRM lead. People
// an upload adds after that copy aren't in it, so the run marks them removed,
// deletes the matches the upload's ranking had just made (their DealFlow
// links go dead) and leaves them off its call list. The CRM's 7:00 copy then
// clears their rank, and they show "not ranked" until the next morning.
//
// How the CRM can tell: it can't ask DealFlow whether the run is going (the
// ranking request doesn't say, and the CRM's DealFlow reader is another
// brief's), so it goes by the run's clock, from DealFlow's own settings:
//   - the run is scheduled at 09:00 UTC (5:00 am EDT, 4:00 am EST: DealFlow's
//     vercel.json "0 9 * * *"), and Vercel's Hobby plan starts it at some
//     minute of that hour (it has run at 09:17–09:18);
//   - Vercel stops it after 300 seconds (its maxDuration).
// So only people ranked from 09:00 to 10:05 UTC can have been missed, and a
// run that missed an upload's people had started before the upload finished,
// so it is over 5 minutes after that. Two minutes either side for the two
// servers' clocks and the cron's start [engineering precaution].
//
// What the CRM does (driver.ts): for an upload whose people were ranked in
// that hour, it waits until 7 minutes after the upload finished, then asks
// DealFlow once more for those same people. DealFlow copies them back, scores
// them and gives them fresh links, and the CRM writes their rank after the
// run's call list was made, which the 7:00 copy keeps (its Brief 45 guard).
// DealFlow accepts an upload's ranking for an hour after it finished, so the
// second ask always fits. Nothing here contacts anyone.
//
// Not covered: a run started by hand at another time of day (Vercel's "Run"
// button). Browser-safe: no imports.

/** DealFlow's nightly cron hour, UTC (DealFlow vercel.json: "0 9 * * *"). */
export const DEALFLOW_NIGHTLY_UTC_HOUR = 9
/** Vercel stops DealFlow's nightly run after this long (its route's maxDuration = 300). */
export const DEALFLOW_NIGHTLY_MAX_RUN_MS = 300_000
/** Room for the two servers' clocks and the cron's start [engineering precaution]. */
export const NIGHTLY_CLOCK_MARGIN_MS = 120_000

const HOUR_MS = 3_600_000
const DAY_MS = 24 * HOUR_MS
const RISK_FROM_MS = DEALFLOW_NIGHTLY_UTC_HOUR * HOUR_MS - NIGHTLY_CLOCK_MARGIN_MS
const RISK_UNTIL_MS = (DEALFLOW_NIGHTLY_UTC_HOUR + 1) * HOUR_MS + DEALFLOW_NIGHTLY_MAX_RUN_MS + NIGHTLY_CLOCK_MARGIN_MS

const clockTime = (ms: number) => new Date(ms).toISOString().slice(11, 19)
/** From this time of day (UTC) a ranking may have overlapped the run: "08:58:00". */
export const NIGHTLY_RISK_FROM_UTC = clockTime(RISK_FROM_MS)
/** Up to (not including) this time of day (UTC): "10:07:00". */
export const NIGHTLY_RISK_UNTIL_UTC = clockTime(RISK_UNTIL_MS)

/** Whether a ranking written at `at` may have overlapped DealFlow's nightly run. */
export function rankedDuringNightly(at: Date): boolean {
  const ms = ((at.getTime() % DAY_MS) + DAY_MS) % DAY_MS
  return ms >= RISK_FROM_MS && ms < RISK_UNTIL_MS
}

/** How long after an upload finished every run that could have missed its people has ended: 7 minutes. */
export const NIGHTLY_SAFE_AFTER_MS = DEALFLOW_NIGHTLY_MAX_RUN_MS + NIGHTLY_CLOCK_MARGIN_MS

/** The moment every run that could have missed this upload's people has ended. */
export function nightlySafeAfter(completedAt: Date): Date {
  return new Date(completedAt.getTime() + NIGHTLY_SAFE_AFTER_MS)
}
