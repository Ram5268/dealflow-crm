import { ABANDONMENT_BANDS } from '@/lib/telephony/pacing/computeNewLineCount'

/** Spend-bar tone thresholds (M5 §8): warn at 80% of cap, danger at 95%. */
export const SPEND_WARN_RATIO = 0.8
export const SPEND_DANGER_RATIO = 0.95

export type SpendTone = 'ok' | 'warn' | 'danger'

/**
 * Tone for the month-to-date spend bar. A non-positive cap is `danger`, not a
 * divide-by-zero: a cap of 0 means every dollar is over budget, and B's pacing
 * worker halts the dialer on `spend >= cap` in exactly that case.
 */
export function spendTone(spendUsd: number, capUsd: number): SpendTone {
  if (capUsd <= 0) return 'danger'
  const ratio = spendUsd / capUsd
  if (ratio >= SPEND_DANGER_RATIO) return 'danger'
  if (ratio >= SPEND_WARN_RATIO) return 'warn'
  return 'ok'
}

/** Bar width as a percentage, clamped so an over-cap month still renders 100%. */
export function spendPercent(spendUsd: number, capUsd: number): number {
  if (capUsd <= 0) return 100
  return Math.max(0, Math.min(100, (spendUsd / capUsd) * 100))
}

export function formatUsd(n: number): string {
  return n.toLocaleString('en-US', { style: 'currency', currency: 'USD' })
}

/**
 * Seconds of talk time as minutes. Rounded to one decimal because a solo
 * broker's month is tens of minutes, where whole-minute rounding hides the
 * difference between "no calls" and "a few short ones".
 */
export function formatMinutes(totalSeconds: number): string {
  const mins = totalSeconds / 60
  return mins === 0 ? '0' : mins.toFixed(1)
}

/**
 * Mask the middle of an E.164 caller ID: +12125550143 -> +1 (212) •••-0143.
 * Returned verbatim when it is not an 11-digit +1 number, so a misconfigured
 * value stays visible rather than being silently prettified into nonsense.
 */
export function maskCallerId(raw: string): string {
  const digits = raw.replace(/\D/g, '')
  if (digits.length !== 11 || !digits.startsWith('1')) return raw
  return `+1 (${digits.slice(1, 4)}) •••-${digits.slice(7)}`
}

const DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']

/** `[1,2,3,4,5]` -> "Mon–Fri"; non-contiguous sets list every day. */
export function formatAllowedDays(days: number[]): string {
  const sorted = [...new Set(days)].filter((d) => d >= 0 && d <= 6).sort((a, b) => a - b)
  if (sorted.length === 0) return 'No days'
  if (sorted.length === 7) return 'Every day'
  const contiguous = sorted.every((d, i) => i === 0 || d === sorted[i - 1] + 1)
  if (contiguous && sorted.length > 2) return `${DOW[sorted[0]]}–${DOW[sorted[sorted.length - 1]]}`
  return sorted.map((d) => DOW[d]).join(', ')
}

/** 9 -> "9am", 20 -> "8pm", 0 -> "12am". */
export function formatHour(hour24: number): string {
  const suffix = hour24 < 12 ? 'am' : 'pm'
  const h = hour24 % 12 === 0 ? 12 : hour24 % 12
  return `${h}${suffix}`
}

/**
 * `earliestHour`/`latestHour` are a half-open [earliest, latest) window in
 * windowCheck.ts — an hour of 20 is already outside a latestHour of 20. The
 * label therefore ends at `latestHour`, NOT `latestHour + 1`: writing "9pm" for
 * latestHour 20 would advertise an hour C blocks.
 */
export function formatWindow(earliestHour: number, latestHour: number): string {
  return `${formatHour(earliestHour)}–${formatHour(latestHour)}`
}

export interface PacingBandRow {
  band: number
  range: string
  action: string
  lines: string
}

/**
 * The FTC-abandonment band table, derived from B's exported thresholds so this
 * display can never drift from the control law it describes.
 */
export function pacingBandRows(): PacingBandRow[] {
  const pct = (n: number) => `${(n * 100).toFixed(1)}%`
  const { HOLD_FLOOR, DECREASE_FLOOR, FORCE_SINGLE_FLOOR, HALT_FLOOR } = ABANDONMENT_BANDS
  return [
    { band: 1, range: `< ${pct(HOLD_FLOOR)}`, action: 'Increase', lines: 'current + 1' },
    { band: 2, range: `${pct(HOLD_FLOOR)} – ${pct(DECREASE_FLOOR)}`, action: 'Hold', lines: 'current' },
    { band: 3, range: `${pct(DECREASE_FLOOR)} – ${pct(FORCE_SINGLE_FLOOR)}`, action: 'Decrease', lines: 'current − 1' },
    { band: 4, range: `${pct(FORCE_SINGLE_FLOOR)} – ${pct(HALT_FLOOR)}`, action: 'Force single', lines: '1' },
    { band: 5, range: `≥ ${pct(HALT_FLOOR)}`, action: 'Halt', lines: '0' },
  ]
}

/**
 * Whether a stored credential counts as a connected mailbox.
 *
 * `markRevoked` KEEPS the row — it blanks the tokens and sets status
 * `revoked` — so presence of a row is not connection. `error` and
 * `reauth_required` stay connected-but-unhealthy: the mailbox is still linked
 * and the badge says what is wrong, which is what Ryan needs to act on.
 */
export function isMailboxConnected(cred: { status: string } | null | undefined): boolean {
  if (!cred) return false
  return cred.status !== 'revoked'
}
