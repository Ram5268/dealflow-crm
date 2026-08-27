import { DateTime } from 'luxon'

/**
 * Sequence scheduling — pure, timezone/DST-aware date math (luxon).
 *
 * Brief §3.4 mandates luxon (NOT date-fns-tz): luxon's calendar-unit arithmetic
 * (`plus({ days })`) preserves local wall-clock time across DST transitions,
 * which is exactly what "same local hour on the next non-blackout day" needs and
 * is the class of bug (DST double-fire) the brief calls out.
 *
 * These functions are deterministic and take no ambient clock — the caller
 * (`tick.ts`) supplies `enrolledAt` and `now`, so they unit-test cleanly.
 */

/**
 * Display/scheduling-layer timezone fallback for contacts with no timezone.
 * Per cross-brief critique G2 this fallback is scheduling-only; it never enters
 * the compliance check (SMS steps still fail-closed through Agent C, which does
 * NOT fall back). See tick.ts.
 */
export const DEFAULT_TIMEZONE = 'America/New_York'

export interface SequenceStepLike {
  id: string
  ordinal: number
  delayHours: number
}

/**
 * Due time for the step identified by `currentStepId`: `enrolledAt` plus the sum
 * of `delayHours` for every step from the first (lowest ordinal) through the
 * current step, inclusive. Returns a UTC `DateTime`.
 *
 * The sum is elapsed absolute hours, so it's added to the UTC instant directly —
 * DST does not distort a duration measured in hours. (DST only matters for the
 * local-calendar-day math in `applyBlackoutDates`.)
 */
export function nextStepDueAt(
  enrolledAt: Date,
  steps: SequenceStepLike[],
  currentStepId: string,
): DateTime {
  const ordered = [...steps].sort((a, b) => a.ordinal - b.ordinal)
  const idx = ordered.findIndex((s) => s.id === currentStepId)
  if (idx === -1) {
    throw new Error(
      `nextStepDueAt: currentStepId "${currentStepId}" not found among steps`,
    )
  }
  const totalDelay = ordered
    .slice(0, idx + 1)
    .reduce((sum, s) => sum + s.delayHours, 0)

  return DateTime.fromJSDate(enrolledAt, { zone: 'utc' }).plus({
    hours: totalDelay,
  })
}

/**
 * If `dueAt` — interpreted in the contact's local timezone — falls on a calendar
 * date (YYYY-MM-DD) listed in `blackoutDates`, advance ONE contact-local day at a
 * time, preserving the same local hour+minute, until the date is not a blackout
 * day. DST-aware via luxon `plus({ days: 1 })` (keeps wall-clock time across a
 * transition; never double-fires or drifts an hour).
 *
 * `blackoutDates` are contact-local calendar dates the user does not want any
 * send on. Weekends are NOT implicitly blackout — Ryan adds them explicitly if
 * he wants them off (brief §3.4 spec clarification).
 *
 * Returns a UTC `DateTime`.
 */
export function applyBlackoutDates(
  dueAt: DateTime,
  blackoutDates: string[],
  contactTimezone: string,
): DateTime {
  let local = dueAt.setZone(contactTimezone)
  // Invalid/unknown zone → fall back to the default scheduling zone rather than
  // producing an invalid DateTime that would crash the tick.
  if (!local.isValid) local = dueAt.setZone(DEFAULT_TIMEZONE)

  if (blackoutDates.length === 0) return local.toUTC()

  const blackout = new Set(blackoutDates)
  // Safety bound: a pathological all-days-blackout config shouldn't loop forever.
  let guard = 0
  while (blackout.has(local.toFormat('yyyy-MM-dd'))) {
    local = local.plus({ days: 1 })
    if (++guard > 3660) {
      throw new Error(
        'applyBlackoutDates: blackout deferral exceeded ~10 years; check blackoutDates config',
      )
    }
  }
  return local.toUTC()
}

/**
 * Convenience composition used by the tick: compute the raw due time then defer
 * off any blackout days. Returns UTC.
 */
export function resolveDueAt(params: {
  enrolledAt: Date
  steps: SequenceStepLike[]
  currentStepId: string
  blackoutDates: string[]
  contactTimezone: string | null | undefined
}): DateTime {
  const tz = params.contactTimezone ?? DEFAULT_TIMEZONE
  const raw = nextStepDueAt(params.enrolledAt, params.steps, params.currentStepId)
  return applyBlackoutDates(raw, params.blackoutDates, tz)
}
