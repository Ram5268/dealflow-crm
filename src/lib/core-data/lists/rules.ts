// Brief 45 — the pure rules behind folders, lists, groups and ranking. No I/O,
// no Prisma: the server uses them, and so can the browser.
import { GROUP_COLORS, NAME_MAX, type GroupColor, type NotRankedReason, type RankState } from './types'

// ─── Names [brief §5.1: the planner's design, approved by Ryan 2026-10-18] ───

export const NAME_LENGTH_ERROR = `Name must be 1–${NAME_MAX} characters.`
export const NAME_CONTROL_ERROR = "Names can't contain line breaks, tabs or other control characters."

export function normalizeName(raw: string): string {
  return raw.normalize('NFC').trim()
}

// Characters as people count them (code points), so an emoji is one, not two.
const length = (s: string) => Array.from(s).length

// [engineering precaution] a line break or control character in a name breaks
// the sidebar's one-line rows and the CSV file names.
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/

/** The plain-English problem with a name, or null when it's fine. */
export function nameProblem(raw: unknown): string | null {
  if (typeof raw !== 'string') return NAME_LENGTH_ERROR
  const name = normalizeName(raw)
  if (length(name) < 1 || length(name) > NAME_MAX) return NAME_LENGTH_ERROR
  if (CONTROL.test(name)) return NAME_CONTROL_ERROR
  return null
}

export function isGroupColor(c: unknown): c is GroupColor {
  return typeof c === 'string' && (GROUP_COLORS as readonly string[]).includes(c)
}

export const COLOR_ERROR = `Pick one of these colors: ${GROUP_COLORS.join(', ')}.`

// ─── Ranking [brief §5.5; CONTRACT §3] ───────────────────────────────────────

// Mojo's "Call Attempts": valueNumber, else a strictly numeric valueText, else
// 0. ASCII digits and whitespace only, spelled the same way in SQL (sql.ts),
// so the database and compareRank always agree. At most 9 digits on each side
// of the point [engineering precaution]: a few hundred digits would overflow
// Postgres's float8 cast and break every ranked page of the org.
const ATTEMPTS_RE = /^[ \t\n\r\f\v]*([0-9]{1,9}(?:\.[0-9]{1,9})?)[ \t\n\r\f\v]*$/
/** The same pattern for Postgres (capture group 1 is the number). */
export const ATTEMPTS_PATTERN_SQL = '^[ \t\n\r\f\v]*([0-9]{1,9}(\\.[0-9]{1,9})?)[ \t\n\r\f\v]*$'

export function attemptsFrom(valueNumber: number | null | undefined, valueText: string | null | undefined): number {
  if (valueNumber !== null && valueNumber !== undefined) return valueNumber
  const m = valueText?.match(ATTEMPTS_RE)
  return m ? Number(m[1]) : 0
}

export interface RankKey {
  id: string
  priorityScore: number | null
  topMatchFit: number | null
  attempts: number
  createdAt: Date | string
}

const time = (d: Date | string) => (d instanceof Date ? d.getTime() : new Date(d).getTime())

// Higher first, blanks last.
function descNullsLast(a: number | null, b: number | null): number {
  if (a === null) return b === null ? 0 : 1
  if (b === null) return -1
  return b - a
}

/**
 * The ranking, as a comparator: DealFlow priority (highest first, unscored
 * last), then best buyer fit, then fewest call attempts, then who was added
 * first, then id (by code unit, like Postgres COLLATE "C"). Mirrors the SQL in
 * sql.ts exactly; a DB test proves they agree.
 */
export function compareRank(a: RankKey, b: RankKey): number {
  return (
    descNullsLast(a.priorityScore, b.priorityScore) ||
    descNullsLast(a.topMatchFit, b.topMatchFit) ||
    a.attempts - b.attempts ||
    time(a.createdAt) - time(b.createdAt) ||
    (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
  )
}

// DealFlow lib/matching/tiers.ts (HOT_MIN_FIT 80, WARM_MIN_FIT 65).
export const HOT_MIN_FIT = 80
export const WARM_MIN_FIT = 65
/** "Has a strong buyer" = a HOT match. */
export const STRONG_BUYER_MIN_FIT = HOT_MIN_FIT

export function tierOf(topMatchFit: number | null): 'hot' | 'warm' | 'possible' | 'none' {
  if (topMatchFit === null) return 'none'
  if (topMatchFit >= HOT_MIN_FIT) return 'hot'
  if (topMatchFit >= WARM_MIN_FIT) return 'warm'
  return 'possible'
}

export interface RankStateInput {
  priorityScore: number | null
  dealflowSignalSyncedAt: Date | null
  mojoId: string | null
  createdAt: Date
}

/**
 * Why a row is (or isn't) ranked, for its badge [CONTRACT §3]:
 *  - ranked: DealFlow scored it;
 *  - not ranked, no match: DealFlow looked (it synced this lead) and found no
 *    buyer match;
 *  - not ranked, no Mojo ID: DealFlow's lead copy reads only leads with a Mojo
 *    ID, so it never sees this one, however old it is;
 *  - not ranked, no match: it was already in the CRM for the last ranking;
 *  - scoring…: new since the last ranking, not scored yet (sorts last).
 * The Mojo ID check comes before the "was there for the last ranking" one, so
 * an old lead without a Mojo ID says why it will never rank (judgment call,
 * reported to the executor).
 */
export function rankStateOf(row: RankStateInput, rankingCutoff: Date | null): { rankState: RankState; notRankedReason: NotRankedReason | null } {
  if (row.priorityScore !== null) return { rankState: 'ranked', notRankedReason: null }
  if (row.dealflowSignalSyncedAt) return { rankState: 'not_ranked', notRankedReason: 'no_match' }
  if (!row.mojoId) return { rankState: 'not_ranked', notRankedReason: 'no_mojo_id' }
  if (rankingCutoff && row.createdAt.getTime() < rankingCutoff.getTime()) return { rankState: 'not_ranked', notRankedReason: 'no_match' }
  return { rankState: 'scoring', notRankedReason: null }
}

// ─── The Pipeline's value range (Brief 45 PR G) ──────────────────────────────

/** The value range's highest amount: Brief 44's cap on an estimate, $1,000,000,000. */
export const VALUE_FILTER_MAX = 1_000_000_000

/**
 * A value-range end as the query string and saved workflows write it: whole
 * dollars, digits only, 0 to VALUE_FILTER_MAX, without leading zeros
 * ("0900000" reads as "900000"). Null for anything else (cents, commas, "1.5M":
 * the Filters panel turns those into dollars first).
 */
export function canonicalDollars(raw: string): string | null {
  const s = raw.trim()
  if (!/^[0-9]{1,10}$/.test(s)) return null
  const n = Number(s)
  return n <= VALUE_FILTER_MAX ? String(n) : null
}
