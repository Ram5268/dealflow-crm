// Brief 45 — the words and numbers the sidebar, the list pages and All leads
// show: counts, "ranked 7:02" stamps, a list's source line, the rank-state
// badges and a lead's local time with the calling-hours dot. Pure and
// browser-safe (no Prisma, no DOM). Times are New York time.
import { DateTime } from 'luxon'
import { timezoneLabel } from '@/lib/core-data/dealflow-sync/labels'
import type { CallingWindowDTO, NotRankedReason, RankState } from '@/lib/core-data/lists/types'

export const NY = 'America/New_York'

export const formatCount = (n: number) => n.toLocaleString('en-US')
export const peopleCount = (n: number) => `${formatCount(n)} ${n === 1 ? 'person' : 'people'}`

const inNY = (iso: string) => DateTime.fromISO(iso, { zone: 'utc' }).setZone(NY).setLocale('en-US')
const nowNY = (now: Date) => DateTime.fromJSDate(now).setZone(NY).setLocale('en-US')
const clock = (d: DateTime) => d.toFormat('h:mm a').toLowerCase() // "7:02 am"
const day = (d: DateTime, today: DateTime) => d.toFormat(d.hasSame(today, 'year') ? 'LLL d' : 'LLL d, yyyy')

/**
 * The sidebar's stamp for the last morning ranking: "ranked 7:02" today,
 * "ranked Oct 17, 7:02" on another day; null before the first ranking.
 */
export function rankedStamp(rankedAt: string | null, now: Date): string | null {
  if (!rankedAt) return null
  const at = inNY(rankedAt)
  if (!at.isValid) return null
  const today = nowNY(now)
  return at.hasSame(today, 'day') ? `ranked ${at.toFormat('h:mm')}` : `ranked ${day(at, today)}, ${at.toFormat('h:mm')}`
}

/** A list header's line: "Ranked today at 7:02 am", or the date when it wasn't today. */
export function rankedHeadline(rankedAt: string | null, now: Date): string {
  const at = rankedAt ? inNY(rankedAt) : null
  if (!at?.isValid) return 'Not ranked yet'
  const today = nowNY(now)
  return at.hasSame(today, 'day') ? `Ranked today at ${clock(at)}` : `Ranked ${day(at, today)} at ${clock(at)}`
}

/** "Uploaded Oct 18 · 412 people" for an upload, "Created by you · 41 people" otherwise. */
export function sourceLine(list: { source: string; uploadedAt?: string; createdAt: string; memberCount: number }): string {
  const people = peopleCount(list.memberCount)
  if (!list.source.startsWith('upload:')) return `Created by you · ${people}`
  const at = inNY(list.uploadedAt ?? list.createdAt)
  return at.isValid ? `Uploaded ${at.toFormat('LLL d')} · ${people}` : `Uploaded · ${people}`
}

// ─── Rank-state badges (CONTRACT §3) ─────────────────────────────────────────

export interface RankBadge {
  label: string
  /** Plain-English tooltip. */
  help: string
}

export const RANK_BADGES = {
  scoring: {
    label: 'scoring…',
    help: "New since the last ranking, and DealFlow hasn't scored this person yet. They sit at the bottom of the list until it does.",
  },
  no_match: {
    label: 'not ranked: no buyer match yet',
    help: 'DealFlow looked at this person and found no buyer who fits yet, so they sit at the bottom of the list until one does.',
  },
  no_mojo_id: {
    label: 'not ranked: no Mojo ID',
    help: 'This person has no Mojo ID. DealFlow only ranks people who have one, so they sit at the bottom of the list.',
  },
} as const satisfies Record<'scoring' | NotRankedReason, RankBadge>

/** The badge for a row that isn't ranked, or null for a ranked row. */
export function rankBadge(row: { rankState: RankState; notRankedReason: NotRankedReason | null }): RankBadge | null {
  if (row.rankState === 'ranked') return null
  if (row.rankState === 'scoring') return RANK_BADGES.scoring
  return RANK_BADGES[row.notRankedReason ?? 'no_match']
}

// ─── Local time and the calling-hours dot (CONTRACT §6a) ────────────────────

/** The code default for a zone with no saved window: 9 am–8 pm, Monday–Friday, unconfirmed. */
export const DEFAULT_CALLING_WINDOW: CallingWindowDTO = {
  earliestHour: 9, latestHour: 20, allowedDaysOfWeek: [1, 2, 3, 4, 5], confirmed: false,
}

export interface LocalTimeInfo {
  /** "3:42 pm" in the lead's zone. */
  time: string
  /** "Eastern" (or the zone name when it has no short label). */
  zone: string
  inside: boolean
  /** "Inside calling hours (not confirmed yet)" — never "OK to call". */
  label: string
}

/**
 * A lead's local time and whether it falls inside the calling window, for the
 * dot on list rows. Display only: it says "inside / outside calling hours",
 * never "OK to call", and adds "(not confirmed yet)" while the window is
 * unconfirmed [engineering precaution: no compliance claim]. Same reading of
 * a window as the dialer's evaluator (src/lib/compliance/timezone/
 * windowCheck.ts): days 0 = Sunday … 6 = Saturday, from earliestHour up to
 * (not including) latestHour. Kept separate from it on purpose: this dot
 * decides nothing. Null when the zone is unknown or not a real zone.
 */
export function localTimeInfo(timezone: string | null, window: CallingWindowDTO | undefined, now: Date): LocalTimeInfo | null {
  if (!timezone) return null
  const local = DateTime.fromJSDate(now).setZone(timezone).setLocale('en-US')
  if (!local.isValid) return null
  const w = window ?? DEFAULT_CALLING_WINDOW
  const dayOfWeek = local.weekday % 7 // luxon: 1 = Monday … 7 = Sunday
  const inside = local.hour >= w.earliestHour && local.hour < w.latestHour && w.allowedDaysOfWeek.includes(dayOfWeek)
  return {
    time: clock(local),
    zone: timezoneLabel(timezone) ?? timezone,
    inside,
    label: `${inside ? 'Inside' : 'Outside'} calling hours${w.confirmed ? '' : ' (not confirmed yet)'}`,
  }
}
