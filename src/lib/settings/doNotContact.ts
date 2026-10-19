import { DateTime } from 'luxon'
import { DISPLAY_TZ } from '@/lib/ui/time'

/**
 * Brief 47 (PR 5): Settings → Do not contact. Ryan adds an opt-out himself
 * (a phone and an optional reason) and sees the internal opt-out list. Before
 * this, the only ways in were the API and a STOP text.
 *
 * - Adding goes through the existing `POST /api/compliance/dnc/internal`,
 *   unchanged (canonical E.164, idempotent, 400 for a value that isn't a phone).
 * - Only a stored number's last 4 digits leave the server: the list is mapped
 *   here, on the server, before anything reaches the page [engineering
 *   precaution].
 * - There is no way to remove an opt-out on this screen: removing one allows
 *   contact again, so it stays API-only [engineering precaution].
 *
 * Pure (no database, no `server-only`): the list read takes its db, and the
 * client form imports `submitOptOut` from here.
 */

/** `addedBy` on rows added from this screen (SMS STOP writes 'sms-inbound-handler'). */
export const DO_NOT_CONTACT_ADDED_BY = 'settings-do-not-contact'

/** The existing add route; this screen doesn't change what it does. */
export const DO_NOT_CONTACT_ENDPOINT = '/api/compliance/dnc/internal'

/** The list shows the newest this many; the total is always shown. */
export const DO_NOT_CONTACT_ROW_CAP = 200

/** One opt-out as the page gets it: never the full number. */
export interface OptOutRow {
  /** The stored number's last 4 digits, or null when it has too few digits to show any. */
  last4: string | null
  /** Plain-English reason, or null when none was given. */
  reason: string | null
  /** When it was added, ISO (UTC). */
  addedAt: string
}

export interface DoNotContactList {
  /** Every internal opt-out for the organization. */
  total: number
  /** True when `rows` holds only the newest DO_NOT_CONTACT_ROW_CAP. */
  capped: boolean
  rows: OptOutRow[]
}

/* ------------------------------------------------------------- masking -- */

// Fewer digits than a 7-digit local number: showing the last 4 would show most
// or all of the value, so none are shown.
const MIN_DIGITS_TO_SHOW = 7

export function last4Of(stored: string | null | undefined): string | null {
  const digits = (stored ?? '').replace(/\D/g, '')
  return digits.length >= MIN_DIGITS_TO_SHOW ? digits.slice(-4) : null
}

/** "•••• 0123", or "••••" when there are no digits to show. */
export function maskedPhone(last4: string | null): string {
  return last4 ? `•••• ${last4}` : '••••'
}

// A run of digits, possibly split by spaces, dots, hyphens or parentheses, with
// an optional leading "+".
const DIGIT_RUN = /\+?\(?\d[\d\s().-]*\d/g

/**
 * A reason is free text, so a number typed into it is masked like the list's
 * own column. A run is phone-like at 7 digits (local) or 10 and more; 8 digits
 * is left alone so a date like 2026-10-19 reads as typed.
 */
export function redactPhoneNumbers(text: string): string {
  return text.replace(DIGIT_RUN, (run) => {
    const n = run.replace(/\D/g, '').length
    return n === 7 || n >= 10 ? maskedPhone(last4Of(run)) : run
  })
}

// The codes the SMS STOP handler stores (comms/sms/stop-handler.ts), in plain
// English. Anything else was typed by a person and is shown as typed.
const REASON_TEXT: Record<string, string> = {
  sms_stop_received: 'Texted STOP',
  sms_stop_phrase: 'A text with a stop word in it',
}

export function toOptOutRow(row: { phone: string | null; reason: string | null; addedAt: Date }): OptOutRow {
  const reason = row.reason?.trim()
  return {
    last4: last4Of(row.phone),
    reason: reason ? (REASON_TEXT[reason] ?? redactPhoneNumbers(reason)) : null,
    addedAt: row.addedAt.toISOString(),
  }
}

/** "Oct 19, 2026", the New York calendar date. */
export function formatAddedDate(iso: string): string {
  return DateTime.fromISO(iso, { zone: 'utc' }).setZone(DISPLAY_TZ).toFormat('LLL d, yyyy')
}

/* ---------------------------------------------------------------- read -- */

export interface DoNotContactDb {
  dncSuppression: {
    count: (args: any) => Promise<number>
    findMany: (args: any) => Promise<Array<{ phone: string; reason: string | null; addedAt: Date }>>
  }
}

/**
 * Read only: this organization's internal opt-outs (not the federal or state
 * registry rows), newest first, capped, each mapped to its last 4 digits.
 */
export async function readDoNotContactList(db: DoNotContactDb, organizationId: string): Promise<DoNotContactList> {
  const where = { organizationId, source: 'internal' }
  const [total, found] = await Promise.all([
    db.dncSuppression.count({ where }),
    db.dncSuppression.findMany({
      where,
      orderBy: [{ addedAt: 'desc' }, { id: 'desc' }],
      take: DO_NOT_CONTACT_ROW_CAP,
      select: { phone: true, reason: true, addedAt: true },
    }),
  ])
  const rows = found.map(toOptOutRow)
  return { total: Math.max(total, rows.length), capped: total > rows.length, rows }
}

/* ----------------------------------------------------------------- add -- */

export type OptOutOutcome =
  | { kind: 'added' | 'already'; message: string }
  | { kind: 'empty' | 'invalid' | 'error'; message: string }

export const OPT_OUT_MESSAGES = {
  empty: 'Type a phone number first.',
  invalid: "That doesn't look like a phone number.",
  error: 'Something went wrong, so the number may not be on the list. Try again: adding a number twice is safe.',
} as const

/**
 * What the form does on submit. Success only on the route's own 201 reply;
 * a 400 is a number the route refused; anything else (an error, a login
 * prompt, a network failure) is a generic error, never "Added".
 */
export async function submitOptOut(
  input: { phone: string; reason?: string },
  fetchImpl: typeof fetch = (url, init) => fetch(url, init),
): Promise<OptOutOutcome> {
  const phone = input.phone.trim()
  if (!phone) return { kind: 'empty', message: OPT_OUT_MESSAGES.empty }
  const reason = input.reason?.trim() || undefined

  let res: Response
  try {
    res = await fetchImpl(DO_NOT_CONTACT_ENDPOINT, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ phone, reason, addedBy: DO_NOT_CONTACT_ADDED_BY }),
    })
  } catch {
    return { kind: 'error', message: OPT_OUT_MESSAGES.error }
  }
  if (res.status === 400) return { kind: 'invalid', message: OPT_OUT_MESSAGES.invalid }
  if (res.status !== 201) return { kind: 'error', message: OPT_OUT_MESSAGES.error }

  const body = (await res.json().catch(() => null)) as { source?: unknown; added?: unknown; phone?: unknown } | null
  if (body?.source !== 'internal' || typeof body.added !== 'boolean') {
    return { kind: 'error', message: OPT_OUT_MESSAGES.error }
  }
  const shown = maskedPhone(last4Of(typeof body.phone === 'string' ? body.phone : null))
  return body.added
    ? { kind: 'added', message: `Added ${shown}. This CRM won't call or text it.` }
    : { kind: 'already', message: `Already on the list (${shown}).` }
}
