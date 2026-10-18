// Brief 45 PR D — how dates read on Pipeline cards and rows: whole days,
// counted on New York calendar dates against the server's "now" (so the
// server and the browser render the same words). Client-safe.
import { DateTime } from 'luxon'
import { DISPLAY_TZ } from '@/lib/ui/time'

const nyDay = (iso: string) => DateTime.fromISO(iso, { zone: 'utc' }).setZone(DISPLAY_TZ).startOf('day')

/** Whole New York days from `iso` to `now` (negative = in the future). */
export function daysBetween(iso: string, now: string): number {
  return Math.round(nyDay(now).diff(nyDay(iso), 'days').days)
}

/** "Oct 10" (New York date). */
export function shortDate(iso: string): string {
  return DateTime.fromISO(iso, { zone: 'utc' }).setZone(DISPLAY_TZ).toFormat('LLL d')
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`

export function lastContactText(iso: string | null, now: string): string {
  if (!iso) return 'Never contacted'
  const d = daysBetween(iso, now)
  if (d <= 0) return 'Last contact today'
  if (d === 1) return 'Last contact yesterday'
  return `Last contact ${d} days ago`
}

/** The table's shorter form. */
export function lastContactShort(iso: string | null, now: string): string {
  if (!iso) return 'Never'
  const d = daysBetween(iso, now)
  if (d <= 0) return 'Today'
  if (d === 1) return 'Yesterday'
  return `${d} days ago`
}

export type DueTone = 'danger' | 'warning' | 'muted'

/** A task's due date: overdue (red), today (amber), or when. */
export function dueText(iso: string | null, now: string): { label: string; tone: DueTone } | null {
  if (!iso) return null
  const d = daysBetween(iso, now)
  if (d > 0) return { label: `overdue since ${shortDate(iso)}`, tone: 'danger' }
  if (d === 0) return { label: 'due today', tone: 'warning' }
  if (d === -1) return { label: 'due tomorrow', tone: 'muted' }
  return { label: `due ${shortDate(iso)}`, tone: 'muted' }
}

/** Time in this column's group: "In Hot for 45 days". */
export function inGroupText(iso: string, now: string, groupName: string): string {
  const d = daysBetween(iso, now)
  if (d <= 0) return `Added to ${groupName} today`
  return `In ${groupName} for ${plural(d, 'day')}`
}

/** The table's shorter form. */
export function inGroupShort(iso: string, now: string): string {
  const d = daysBetween(iso, now)
  return d <= 0 ? 'Today' : plural(d, 'day')
}
