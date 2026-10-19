import type { Prisma, PrismaClient } from '@prisma/client'
import { logger } from '@/lib/logger'
import { captureException } from '@/lib/shared/sentry'

// ─────────────────────────────────────────────────────────────────────────────
// Brief 50 (PR 3): the one place that turns a call or an inbound message into
// an entry on the lead's timeline (an Activity row).
//
// Why it exists: these entries used to be written only by the LISTEN/NOTIFY
// consumer (../events/listen.ts → ../events/handlers/*), and nothing on Vercel
// runs that consumer; only the local scripts/boot-*.ts start it. So production
// never wrote a Call, Email or SMS entry. Now the code that writes the Call or
// Message row calls these functions itself, and the consumer's handlers call
// the same functions, so running both never doubles an entry.
//
// - One Call entry per callId, one entry per messageId. Activity has no unique
//   index on those columns (no schema change in this brief), so each write
//   takes a transaction-scoped advisory lock on its key before it looks, which
//   makes "look, then insert" safe against a second writer at the same moment:
//   a Twilio retry, two overlapping mailbox syncs, or the consumer
//   [engineering precaution].
// - Tenancy: an entry takes the organization of its Call or Message row (never
//   a guessed one), and links a lead or contact only when it belongs to that
//   same organization. A stale or foreign id is dropped rather than failing the
//   write (Activity's lead and contact columns are foreign keys)
//   [engineering precaution].
//
// This only writes rows. Nothing here sends, calls, texts or emails anyone.
// ─────────────────────────────────────────────────────────────────────────────

export type ActivityDb = PrismaClient | Prisma.TransactionClient
type Tx = Prisma.TransactionClient

/** What a write did: wrote a new entry, updated the call's entry, found it
 *  already right, or skipped (no Call/Message row to take tenancy from). */
export type ActivityWrite = 'created' | 'updated' | 'exists' | 'skipped'

export const CALL_ACTIVITY_TYPE = 'Call'
export const CALL_IN_PROGRESS = 'Call in progress'

/**
 * Run `fn` holding the advisory lock for `key`: inside the caller's
 * transaction when given one (released at its commit), otherwise in a short
 * transaction of its own.
 */
async function withEntryLock<T>(db: ActivityDb, key: string, fn: (tx: Tx) => Promise<T>): Promise<T> {
  const run = async (tx: Tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${key}, 0))`
    return fn(tx)
  }
  return '$transaction' in db ? db.$transaction(run) : run(db)
}

interface Tenancy {
  organizationId: string
  leadId: string | null
  contactId: string | null
}

/** Keep a lead/contact link only when it is in `organizationId`. */
async function scoped(
  tx: Tx,
  organizationId: string,
  leadId: string | null | undefined,
  contactId: string | null | undefined,
): Promise<Tenancy> {
  const lead = leadId
    ? await tx.lead.findFirst({ where: { id: leadId, organizationId }, select: { id: true } })
    : null
  const contact = contactId
    ? await tx.contact.findFirst({ where: { id: contactId, organizationId }, select: { id: true } })
    : null
  return { organizationId, leadId: lead?.id ?? null, contactId: contact?.id ?? null }
}

const callKey = (callId: string) => `activity:call:${callId}`
const messageKey = (messageId: string) => `activity:message:${messageId}`

function findCallEntry(tx: Tx, callId: string) {
  return tx.activity.findFirst({
    where: { callId, type: CALL_ACTIVITY_TYPE },
    select: { id: true, bodyText: true },
  })
}

function findCall(tx: Tx, callId: string) {
  return tx.call.findUnique({
    where: { id: callId },
    select: { organizationId: true, leadId: true, contactId: true, activityAt: true },
  })
}

// ─── Calls ───────────────────────────────────────────────────────────────────

export interface CallConnectedInput {
  callId: string
  connectedAt: Date
  /** The event's own lead/contact; used only when there is no Call row. */
  leadId?: string | null
  contactId?: string | null
}

/**
 * An answered call's "Call in progress" entry. Only the event consumer calls
 * this. The live-answer path (twilio/voiceWebhook.ts) deliberately doesn't, so
 * a timeline write never delays bridging a person who just answered
 * [engineering precaution; the FCC/FTC abandoned-call rules allow two seconds
 * to connect them]. Production writes the entry when the call ends instead
 * (recordCallCompleted).
 */
export async function recordCallConnected(db: ActivityDb, input: CallConnectedInput): Promise<ActivityWrite> {
  return withEntryLock(db, callKey(input.callId), async (tx) => {
    if (await findCallEntry(tx, input.callId)) return 'exists'

    let tenancy: Tenancy | null = null
    const call = await findCall(tx, input.callId)
    if (call) {
      tenancy = await scoped(tx, call.organizationId, call.leadId, call.contactId)
    } else if (input.leadId) {
      // No Call row (an event from an older emitter or a test): the lead's
      // organization, the consumer's original rule.
      const lead = await tx.lead.findUnique({ where: { id: input.leadId }, select: { organizationId: true } })
      if (lead) tenancy = await scoped(tx, lead.organizationId, input.leadId, input.contactId)
    }
    if (!tenancy) {
      logger.warn({ callId: input.callId }, 'call activity: no Call row or lead to take the organization from; nothing written')
      return 'skipped'
    }

    await tx.activity.create({
      data: {
        ...tenancy,
        type: CALL_ACTIVITY_TYPE,
        callId: input.callId,
        activityAt: input.connectedAt,
        bodyText: CALL_IN_PROGRESS,
      },
    })
    return 'created'
  })
}

export interface CallCompletedInput {
  callId: string
  disposition: string
  duration: number | null
  /** Decimal-as-string, stored verbatim (never Number(cost)). */
  cost: string | null
  outcomeId?: string | null
}

/** The entry's text: the disposition plus a small JSON blob (cost as given). */
export function callCompletedBody(input: CallCompletedInput): string {
  const meta = {
    disposition: input.disposition,
    duration: input.duration,
    cost: input.cost, // string | null, NOT coerced
    outcomeId: input.outcomeId ?? null,
  }
  return `Call ${input.disposition} ${JSON.stringify(meta)}`
}

/**
 * A finished call's entry: updates the "Call in progress" entry when there is
 * one, otherwise writes it (most calls are never answered by a person, and the
 * live-answer path writes nothing). Callers that own the Call row pass their
 * transaction, so the entry commits with the call's final status.
 */
export async function recordCallCompleted(db: ActivityDb, input: CallCompletedInput): Promise<ActivityWrite> {
  return withEntryLock(db, callKey(input.callId), async (tx) => {
    const bodyText = callCompletedBody(input)
    const existing = await findCallEntry(tx, input.callId)
    if (existing) {
      if (existing.bodyText === bodyText) return 'exists'
      await tx.activity.update({ where: { id: existing.id }, data: { bodyText } })
      return 'updated'
    }

    const call = await findCall(tx, input.callId)
    if (!call) {
      // Never guess the organization (the consumer used to file these under
      // "the first organization", with no lead).
      logger.warn({ callId: input.callId }, 'call activity: no Call row to take the organization from; nothing written')
      return 'skipped'
    }
    await tx.activity.create({
      data: {
        ...(await scoped(tx, call.organizationId, call.leadId, call.contactId)),
        type: CALL_ACTIVITY_TYPE,
        callId: input.callId,
        activityAt: call.activityAt, // when the call was placed
        bodyText,
      },
    })
    return 'created'
  })
}

// ─── Messages ────────────────────────────────────────────────────────────────

export interface MessageReceivedInput {
  messageId: string
  /** The event's own lead/contact; the Message row's are used when absent. */
  leadId?: string | null
  contactId?: string | null
}

/** An inbound email or text's entry, copied from its Message row. */
export async function recordMessageReceived(db: ActivityDb, input: MessageReceivedInput): Promise<ActivityWrite> {
  return withEntryLock(db, messageKey(input.messageId), async (tx) => {
    const existing = await tx.activity.findFirst({ where: { messageId: input.messageId }, select: { id: true } })
    if (existing) return 'exists'

    const message = await tx.message.findUnique({
      where: { id: input.messageId },
      select: {
        id: true, organizationId: true, leadId: true, contactId: true, channel: true,
        activityAt: true, bodyText: true, bodyHtml: true,
      },
    })
    if (!message) {
      logger.warn({ messageId: input.messageId }, 'message activity: Message row not found; nothing written')
      return 'skipped'
    }

    await tx.activity.create({
      data: {
        ...(await scoped(
          tx,
          message.organizationId,
          input.leadId ?? message.leadId,
          input.contactId ?? message.contactId,
        )),
        type: message.channel === 'email' ? 'Email' : 'SMS',
        messageId: message.id,
        activityAt: message.activityAt,
        bodyText: message.bodyText,
        bodyHtml: message.bodyHtml,
      },
    })
    return 'created'
  })
}

/**
 * recordMessageReceived for the inbound-message paths, which must never fail
 * because of the timeline: the message is already saved, and a STOP in it
 * must still be honoured [engineering precaution]. A failure is logged.
 */
export async function recordMessageReceivedSafely(
  db: ActivityDb,
  input: MessageReceivedInput,
): Promise<ActivityWrite | 'failed'> {
  try {
    return await recordMessageReceived(db, input)
  } catch (err) {
    captureException(err, { event: 'activity.message', messageId: input.messageId })
    return 'failed'
  }
}
