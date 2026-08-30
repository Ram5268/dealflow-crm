import { DateTime } from 'luxon'

/**
 * Display timezone for every user-facing timestamp. Duplicated from
 * queue-service's DISPLAY_TZ_FALLBACK rather than imported, because that module
 * pulls in Prisma and this one must stay safe for client components.
 */
export const DISPLAY_TZ = 'America/New_York'

/** "3 minutes ago" / "in 2 hours". Empty string for a missing date. */
export function relativeTime(at: Date | null, now: Date = new Date()): string {
  if (!at) return ''
  return (
    DateTime.fromJSDate(at)
      .setZone(DISPLAY_TZ)
      .toRelative({ base: DateTime.fromJSDate(now).setZone(DISPLAY_TZ) }) ?? ''
  )
}

/** Compact wall-clock stamp: today shows "3:42 PM", older shows "Aug 12". */
export function shortStamp(at: Date | null, now: Date = new Date()): string {
  if (!at) return ''
  const d = DateTime.fromJSDate(at).setZone(DISPLAY_TZ)
  const base = DateTime.fromJSDate(now).setZone(DISPLAY_TZ)
  return d.hasSame(base, 'day') ? d.toFormat('h:mm a') : d.toFormat('LLL d')
}
