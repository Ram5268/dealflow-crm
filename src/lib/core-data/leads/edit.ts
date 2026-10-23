import { z } from 'zod'
import type { Lead, Prisma, PrismaClient } from '@prisma/client'
import { HttpError } from '@/lib/shared/http'
import { toE164 } from '@/lib/shared/phone'
import {
  LEAD_EDIT_ACTIVITY_TYPE,
  NAME_CHANGED,
  addressChange,
  emailAdded,
  emailChanged,
  emailRemoved,
  maskEmail,
  phoneAdded,
  phoneChanged,
  phoneLast4,
  phoneRemoved,
  statusChange,
} from './edit-text'

// Brief 50 PR 5 — editing a lead from its page (item 6.5): the name, status,
// address, and each contact's phones and emails, through PUT
// /api/leads/[id]. Everything else on a lead stays as it is:
//
// - DealFlow's values (priority, match fit, capture, the reason, the DealFlow
//   link, the Mojo ID) come from DealFlow and are refused by name, so a stray
//   client can't overwrite them [engineering precaution]. Our value estimate,
//   property facts and buyer matches aren't Lead columns at all (they're read
//   from DealFlow when the page loads).
// - Phones go through the CRM's one phone parser (src/lib/shared/phone.ts) and
//   are stored in the standard form, +1 and 10 digits, the form the
//   do-not-contact list matches on (Brief 41 H13). A new or changed number
//   that doesn't come out as +1 and 10 digits is refused rather than stored
//   as a foreign number [engineering precaution].
// - Nothing here writes or deletes a do-not-contact entry: those are kept by
//   number (DncSuppression), so removing a phone from a lead leaves its entry
//   in force. A phone marked "texts blocked" and an email marked opted out
//   carry their opt-out on the row itself, so those rows can't be removed or
//   changed here [engineering precaution].
// - One save that changes something writes ONE timeline entry (an Activity of
//   type 'Edit', see ./edit-text.ts) in the same transaction. A save that
//   changes nothing writes nothing.
// - Nothing here calls, texts or emails anyone, or emits an event [Ryan].

/** Lead columns DealFlow's morning copy owns (src/lib/core-data/dealflow-sync/write.ts), plus the Mojo ID it joins on. */
export const DEALFLOW_LEAD_FIELDS = [
  'priorityScore',
  'topMatchFit',
  'captureStatus',
  'matchReason',
  'dealflowDeepLink',
  'dealflowSignalSyncedAt',
  'mojoId',
] as const

const DEALFLOW_MESSAGE =
  "Priority, match fit and the other DealFlow values come from DealFlow and can't be changed here."
const ONLY_FIVE = 'Only the name, status, address, phones and emails can be changed here.'
const RELOAD = 'Reload the page and try again.'

const MAX = { name: 200, status: 100, address: 300, phone: 40, email: 254, rows: 50 } as const

/** The standard US form: +1 and 10 digits. */
export function isStandardUsPhone(e164: string): boolean {
  return /^\+1\d{10}$/.test(e164)
}

// ─── The request ────────────────────────────────────────────────────────────
// A contact's `phones` (or `emails`) says what to do with each number:
// `{ id }` keeps a number as it is, `{ id, phone }` changes it, `{ phone }`
// adds one, and `{ id, remove: true }` removes it. A stored number the request
// doesn't name stays as it is: the form may have been opened before someone
// else added it, and a save never removes a number it wasn't shown
// [engineering precaution]. A contact that isn't sent, or is sent without
// `phones`, keeps its numbers.

const phoneItem = z
  .object({ id: z.string().min(1).optional(), phone: z.string().max(MAX.phone).optional(), remove: z.literal(true).optional() })
  .strict()
  .refine((p) => (p.remove ? p.id !== undefined && p.phone === undefined : p.id !== undefined || p.phone !== undefined))
const emailItem = z
  .object({ id: z.string().min(1).optional(), email: z.string().max(MAX.email).optional(), remove: z.literal(true).optional() })
  .strict()
  .refine((e) => (e.remove ? e.id !== undefined && e.email === undefined : e.id !== undefined || e.email !== undefined))
const contactEdit = z
  .object({
    id: z.string().min(1),
    phones: z.array(phoneItem).max(MAX.rows).optional(),
    emails: z.array(emailItem).max(MAX.rows).optional(),
  })
  .strict()

const leadEditSchema = z
  .object({
    displayName: z.string().trim().min(1).max(MAX.name).optional(),
    statusLabel: z.string().trim().max(MAX.status).nullable().optional(),
    primaryAddressFull: z.string().trim().max(MAX.address).nullable().optional(),
    contacts: z.array(contactEdit).max(MAX.rows).optional(),
  })
  .strict()

export type ContactEditInput = z.infer<typeof contactEdit>

export interface LeadEditInput {
  displayName?: string
  /** null clears it. */
  statusLabel?: string | null
  /** null clears it. */
  primaryAddressFull?: string | null
  contacts?: ContactEditInput[]
}

const bad = (message: string, field?: string) => new HttpError(400, message, field ? { field } : undefined)

const FIELD_WORDS: Record<string, { what: string; max: number }> = {
  displayName: { what: 'The name', max: MAX.name },
  statusLabel: { what: 'The status', max: MAX.status },
  primaryAddressFull: { what: 'The address', max: MAX.address },
}

function friendly(issue: z.ZodError['issues'][number]): HttpError {
  const [top] = issue.path
  if (issue.code === 'unrecognized_keys' && issue.path.length === 0) return bad(ONLY_FIVE)
  if (typeof top === 'string' && FIELD_WORDS[top]) {
    const { what, max } = FIELD_WORDS[top]
    if (issue.code === 'too_small') return bad(`${what} can't be blank.`, top)
    if (issue.code === 'too_big') return bad(`${what} is too long (${max} characters at most).`, top)
    return bad(`${what} must be text.`, top)
  }
  return bad(`The changes couldn't be read. ${RELOAD}`)
}

/** Checks a request body; throws a 400 with a plain-English message (and the field, when there is one). */
export function parseLeadEdit(raw: unknown): LeadEditInput {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw bad(`The changes couldn't be read. ${RELOAD}`)
  const dealflow = DEALFLOW_LEAD_FIELDS.find((k) => k in raw)
  if (dealflow) throw bad(DEALFLOW_MESSAGE, dealflow)
  const parsed = leadEditSchema.safeParse(raw)
  if (!parsed.success) throw friendly(parsed.error.issues[0])
  const d = parsed.data
  const out: LeadEditInput = {}
  if (d.displayName !== undefined) out.displayName = d.displayName
  if (d.statusLabel !== undefined) out.statusLabel = d.statusLabel || null
  if (d.primaryAddressFull !== undefined) out.primaryAddressFull = d.primaryAddressFull || null
  if (d.contacts !== undefined) out.contacts = d.contacts
  return out
}

// ─── Applying it ────────────────────────────────────────────────────────────

// The Railway link is slow (docs/known-drift.md); same limits as Brief 45's
// interactive transactions (src/lib/core-data/lists/sql.ts).
const TX = { maxWait: 10_000, timeout: 30_000 } as const

type Tx = Prisma.TransactionClient

/** What a save does to one contact's phones (or emails). */
interface RowPlan {
  removeIds: string[]
  promoteId: string | null
  create: { value: string; type: string; isPrimary: boolean }[]
}

interface StoredRow {
  id: string
  type: string
  isPrimary: boolean
  createdAt?: Date
}

/** How phones and emails differ; planRows does the rest the same way for both. */
interface RowKind<R extends StoredRow> {
  noun: 'phones' | 'emails'
  stored: (row: R) => string
  /** The form two values are compared in ("1 (212) 555-0101" is the stored +12125550101). */
  same: (text: string) => string
  /** A new or changed value, checked; throws a 400 naming the field. */
  parse: (text: string, field: string) => string
  /** An opt-out kept on the row itself: the row can't be removed or changed here. */
  optedOut: (row: R) => HttpError | null
  defaultType: string
  added: (value: string) => string
  removed: (value: string) => string
  changed: (from: string, to: string) => string
}

type Item = { id?: string; value?: string; remove?: boolean }

function planRows<R extends StoredRow>(kind: RowKind<R>, contactId: string, rows: R[], items: Item[], changes: string[]): RowPlan {
  const field = (i: number) => `contacts.${contactId}.${kind.noun}.${i}`
  const one = kind.noun === 'phones' ? 'phone' : 'email'
  const byId = new Map(rows.map((r) => [r.id, r]))
  const sent = new Set<string>() // stored rows the request names
  const emptied = new Set<string>() // …with their text cleared: removed
  type Op = { keep: R } | { change: R; value: string } | { add: string }
  const ops: Op[] = []
  for (const [i, item] of items.entries()) {
    const text = item.value?.trim()
    if (item.id === undefined) {
      if (text) ops.push({ add: kind.parse(text, field(i)) })
      continue
    }
    const row = byId.get(item.id)
    if (!row) throw bad(`One of the ${kind.noun} isn't on this lead any more. ${RELOAD}`, field(i))
    if (sent.has(row.id)) throw bad(`The same ${one} was sent twice. ${RELOAD}`, field(i))
    sent.add(row.id)
    if (item.remove) {
      emptied.add(row.id)
    } else if (text === undefined || kind.same(text) === kind.same(kind.stored(row))) {
      ops.push({ keep: row }) // untouched, or the same value typed another way
    } else if (text === '') {
      emptied.add(row.id)
    } else {
      const locked = kind.optedOut(row)
      if (locked) throw locked
      ops.push({ change: row, value: kind.parse(text, field(i)) })
    }
  }
  // Not named in the request: kept as it is (see "The request" above).
  for (const r of rows) if (!sent.has(r.id)) ops.push({ keep: r })
  const removed = rows
    .filter((r) => emptied.has(r.id))
    .sort((a, b) => (a.createdAt?.getTime() ?? 0) - (b.createdAt?.getTime() ?? 0) || (a.id < b.id ? -1 : 1))
  for (const r of removed) {
    const locked = kind.optedOut(r)
    if (locked) throw locked
  }

  const plan: RowPlan = { removeIds: removed.map((r) => r.id), promoteId: null, create: [] }
  // The list after the save, in the order sent; a value already there is kept once.
  const values = new Set(ops.flatMap((o) => ('keep' in o ? [kind.same(kind.stored(o.keep))] : [])))
  const final: ({ keep: R } | { create: RowPlan['create'][number] })[] = []
  for (const op of ops) {
    if ('keep' in op) {
      final.push(op)
      continue
    }
    const value = 'change' in op ? op.value : op.add
    if ('change' in op) plan.removeIds.push(op.change.id)
    if (values.has(kind.same(value))) {
      if ('change' in op) changes.push(kind.removed(kind.stored(op.change))) // changed into one it already has
      continue
    }
    values.add(kind.same(value))
    const row = 'change' in op
      ? { value, type: op.change.type, isPrimary: op.change.isPrimary }
      : { value, type: kind.defaultType, isPrimary: false }
    plan.create.push(row)
    final.push({ create: row })
    changes.push('change' in op ? kind.changed(kind.stored(op.change), value) : kind.added(value))
  }
  for (const r of removed) changes.push(kind.removed(kind.stored(r)))
  promoteFirst(final, plan)
  return plan
}

type PhoneRow = StoredRow & { phone: string; outboundSmsBlocked: boolean }
type EmailRow = StoredRow & { email: string; isUnsubscribed: boolean }

const PHONES: RowKind<PhoneRow> = {
  noun: 'phones',
  stored: (r) => r.phone,
  same: (text) => toE164(text) ?? text.trim(),
  parse(text, field) {
    const e164 = toE164(text)
    if (!e164) throw bad(`"${text}" isn't a phone number. Type the 10 digits, like 212-555-0123.`, field)
    // The shared parser reads some numbers as foreign (e.g. "+917…" as India;
    // Brief 50 PR 13 fixes that). Only the standard US form is saved here.
    if (!isStandardUsPhone(e164)) {
      throw bad(`"${text}" reads as a number outside the US. Only US numbers can be saved here: type the 10 digits, like 212-555-0123.`, field)
    }
    return e164
  },
  optedOut: (r) =>
    r.outboundSmsBlocked
      ? bad(`The number ending ${phoneLast4(r.phone) ?? '…'} has texts blocked (an opt-out), so it stays on the lead: it can't be removed or changed here.`)
      : null,
  defaultType: 'mobile', // the CRM's default (the importer's and POST /api/contacts')
  added: phoneAdded,
  removed: phoneRemoved,
  changed: phoneChanged,
}

const EMAILS: RowKind<EmailRow> = {
  noun: 'emails',
  stored: (r) => r.email,
  same: (text) => text.trim().toLowerCase(),
  parse(text, field) {
    const email = text.toLowerCase() // the importer stores emails lowercased
    if (!z.email().safeParse(email).success) throw bad(`"${text}" isn't an email address.`, field)
    return email
  },
  optedOut: (r) =>
    r.isUnsubscribed
      ? bad(`${maskEmail(r.email)} opted out of email, so it stays on the lead: it can't be removed or changed here.`)
      : null,
  defaultType: 'work', // the importer's type for emails
  added: emailAdded,
  removed: emailRemoved,
  changed: emailChanged,
}

// A contact with numbers keeps one primary (the dialer and DealFlow's copy
// read the primary first): if the save removed it, the first one left takes over.
function promoteFirst(final: ({ keep: { id: string; isPrimary: boolean } } | { create: { isPrimary: boolean } })[], plan: RowPlan): void {
  if (final.length === 0) return
  if (final.some((f) => ('keep' in f ? f.keep.isPrimary : f.create.isPrimary))) return
  const first = final[0]
  if ('keep' in first) plan.promoteId = first.keep.id
  else first.create.isPrimary = true
}

/** The status as the organization already spells it, and the id its leads carry, when it's one in use. */
async function knownStatus(tx: Tx, organizationId: string, label: string): Promise<{ label: string; id: string | null } | null> {
  const rows = await tx.lead.groupBy({
    by: ['statusLabel', 'statusId'],
    where: { organizationId, statusLabel: { equals: label, mode: 'insensitive' } },
    _count: { _all: true },
  })
  if (rows.length === 0) return null
  rows.sort((a, b) => b._count._all - a._count._all)
  return { label: rows[0].statusLabel ?? label, id: rows.find((r) => r.statusId)?.statusId ?? null }
}

// P2002: two saves adding the same number at once. P2025: the number to make
// primary was removed elsewhere meanwhile.
const isRace = (err: unknown) => ['P2002', 'P2025'].includes((err as { code?: unknown } | null)?.code as string)

export interface LeadEditResult {
  lead: Lead
  /** The plain-English changes, in the order the timeline entry lists them; empty when nothing changed. */
  changes: string[]
}

/** Applies a checked edit (parseLeadEdit) to one of the organization's leads, in one transaction. */
export async function applyLeadEdit(
  db: PrismaClient,
  organizationId: string,
  leadId: string,
  input: LeadEditInput,
  now: Date = new Date(),
): Promise<LeadEditResult> {
  try {
    return await db.$transaction(async (tx) => {
      const lead = await tx.lead.findFirst({
        where: { id: leadId, organizationId },
        include: { contacts: { include: { phones: true, emails: true } } },
      })
      if (!lead) throw new HttpError(404, 'Lead not found')
      const { contacts, ...current } = lead
      const changes: string[] = []
      const data: Prisma.LeadUpdateInput = {}

      if (input.displayName !== undefined && input.displayName !== lead.displayName.trim()) {
        // Both name columns: the importer treats Lead.name as the owner's name.
        data.displayName = input.displayName
        data.name = input.displayName
        changes.push(NAME_CHANGED)
      }

      if (input.statusLabel !== undefined) {
        const from = lead.statusLabel?.trim() || null
        const to = input.statusLabel
        if ((to ?? '').toLowerCase() !== (from ?? '').toLowerCase()) {
          // A status already in use keeps its spelling and its id (Smart Views
          // can filter on the id), so "contacted" doesn't start a second
          // "Contacted". A new one has no id.
          const known = to ? await knownStatus(tx, organizationId, to) : null
          const label = known?.label ?? to
          data.statusLabel = label
          data.statusId = known?.id ?? null
          changes.push(statusChange(from, label))
        }
      }

      if (input.primaryAddressFull !== undefined) {
        const from = lead.primaryAddressFull?.trim() || null
        const to = input.primaryAddressFull
        if (to !== from) {
          data.primaryAddressFull = to
          // The short form is the part before the first comma, as the importer writes it.
          data.primaryAddressSummary = to ? to.split(',')[0].trim() || to : null
          changes.push(addressChange(from, to))
        }
      }

      const phonePlans: [string, RowPlan][] = []
      const emailPlans: [string, RowPlan][] = []
      const seen = new Set<string>()
      for (const c of input.contacts ?? []) {
        if (seen.has(c.id)) throw bad(`The same contact was sent twice. ${RELOAD}`)
        seen.add(c.id)
        // Only this lead's contacts (and so only this organization's).
        const contact = contacts.find((x) => x.id === c.id)
        if (!contact) throw bad(`One of the contacts isn't on this lead. ${RELOAD}`)
        if (c.phones) {
          const items = c.phones.map((p) => ({ id: p.id, value: p.phone, remove: p.remove }))
          phonePlans.push([contact.id, planRows(PHONES, contact.id, contact.phones, items, changes)])
        }
        if (c.emails) {
          const items = c.emails.map((e) => ({ id: e.id, value: e.email, remove: e.remove }))
          emailPlans.push([contact.id, planRows(EMAILS, contact.id, contact.emails, items, changes)])
        }
      }

      if (changes.length === 0) return { lead: current, changes }

      // A number removed or changed elsewhere since the lead was read: 409
      // (below), not a save on top of a list that's no longer there.
      const gone = (count: number, expected: number) => {
        if (count !== expected) throw new HttpError(409, `This lead changed somewhere else. ${RELOAD}`)
      }
      for (const [contactId, plan] of phonePlans) {
        if (plan.removeIds.length) {
          gone((await tx.contactPhone.deleteMany({ where: { id: { in: plan.removeIds }, contactId } })).count, plan.removeIds.length)
        }
        if (plan.promoteId) await tx.contactPhone.update({ where: { id: plan.promoteId }, data: { isPrimary: true } })
        if (plan.create.length) {
          await tx.contactPhone.createMany({
            data: plan.create.map((p) => ({ contactId, phone: p.value, type: p.type, isPrimary: p.isPrimary })),
          })
        }
      }
      for (const [contactId, plan] of emailPlans) {
        if (plan.removeIds.length) {
          gone((await tx.contactEmail.deleteMany({ where: { id: { in: plan.removeIds }, contactId } })).count, plan.removeIds.length)
        }
        if (plan.promoteId) await tx.contactEmail.update({ where: { id: plan.promoteId }, data: { isPrimary: true } })
        if (plan.create.length) {
          await tx.contactEmail.createMany({
            data: plan.create.map((e) => ({ contactId, email: e.value, type: e.type, isPrimary: e.isPrimary })),
          })
        }
      }
      const updated = await tx.lead.update({ where: { id: lead.id }, data: { ...data, updatedAt: now } })
      await tx.activity.create({
        data: {
          organizationId,
          leadId: lead.id,
          userId: null,
          contactId: null,
          type: LEAD_EDIT_ACTIVITY_TYPE,
          activityAt: now,
          bodyText: changes.join('\n'),
        },
      })
      return { lead: updated, changes }
    }, TX)
  } catch (err) {
    if (isRace(err)) throw new HttpError(409, `This lead changed somewhere else. ${RELOAD}`)
    throw err
  }
}
