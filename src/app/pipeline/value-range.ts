// Brief 45 PR G — the Pipeline's value range (our value estimate, Brief 44):
// what the two boxes accept, and how a range reads on its chip and in notes.
// The URL and the API carry whole dollars ("1500000"; rules.ts
// canonicalDollars); people type "1.5M", "$1,500,000" or "900k". Client-safe.
import { compactMoney } from '@/lib/core-data/dealflow-sync/property'
import { VALUE_FILTER_MAX } from '@/lib/core-data/lists/rules'

export const TYPE_DOLLARS = 'Type a dollar amount, like 1,500,000 or 1.5M.'
export const TOO_BIG = 'Values go up to $1,000,000,000.'
export const BACKWARDS = 'The lowest value is above the highest.'

export type DollarsResult = { ok: true; dollars: number | null } | { ok: false; error: string }

const SUFFIX: Record<string, number> = { k: 1_000, m: 1_000_000, b: 1_000_000_000 }

/**
 * A box's text as whole dollars: "1,500,000", "$1.5M", "900k", "1B". Empty is
 * no bound (null). "1.5" alone is refused rather than guessed at (whole
 * dollars, or 1.5M?); so are negatives and anything over $1,000,000,000.
 */
export function parseDollars(raw: string): DollarsResult {
  if (raw.trim() === '') return { ok: true, dollars: null }
  const s = raw.trim().toLowerCase().replace(/^\$/, '').replace(/[,\s]/g, '')
  const m = /^([0-9]+(?:\.[0-9]+)?|\.[0-9]+)([kmb])?$/.exec(s)
  if (!m || (!m[2] && m[1].includes('.'))) return { ok: false, error: TYPE_DOLLARS }
  const dollars = Math.round(Number(m[1]) * (m[2] ? SUFFIX[m[2]] : 1))
  if (!Number.isFinite(dollars) || dollars > VALUE_FILTER_MAX) return { ok: false, error: TOO_BIG }
  return { ok: true, dollars }
}

/** A box shows the amount with commas ("1,500,000"). */
export const dollarsText = (dollars: string | undefined) => (dollars === undefined ? '' : Number(dollars).toLocaleString('en-US'))

/** "$1.5M–$2.5M", "at least $1.5M", "at most $900K". */
export function valueRangeText(min: string | undefined, max: string | undefined): string {
  const money = (d: string) => compactMoney(Number(d))
  if (min !== undefined && max !== undefined) return `${money(min)}–${money(max)}`
  if (min !== undefined) return `at least ${money(min)}`
  return max !== undefined ? `at most ${money(max)}` : ''
}
