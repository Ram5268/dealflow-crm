import { prisma } from '../../prisma'
import { getCorrelationId } from '../../shell/correlationId'
import { notifyMessageReceived } from '../events'
import { updateGmailHistoryId } from '../oauth/store'
import { GmailClient } from './gmail-client'
import type { SyncPorts, PersistableMessage } from './gmail-sync'
import type { ThreadAggregate, ThreadContactMatch } from './thread-reconstruct'

/**
 * The real `SyncPorts` implementation: Gmail API (via GmailClient) + Prisma +
 * NOTIFY + credential-cursor persistence. The orchestration in `gmail-sync.ts`
 * is provider-agnostic and tested with fakes; this module is the thin,
 * side-effecting adapter it runs against in production.
 */
export function createGmailSyncPorts(params: {
  orgId: string
  credentialId: string
  connectedEmail: string
  accessToken: string
}): SyncPorts {
  const gmail = GmailClient.forAccessToken(params.accessToken)
  return {
    connectedEmail: params.connectedEmail,
    listThreadIds: (query) => gmail.listThreadIds(query),
    getThreadMessages: (threadId) => gmail.getThreadMessages(threadId),
    listChangedThreadIds: (startHistoryId) => gmail.listChangedThreadIds(startHistoryId),
    resolveContact: (emails) => resolveContact(params.orgId, emails),
    upsertThread: (agg) => upsertThread(params.orgId, agg),
    saveMessages: (rows) => saveMessages(params.orgId, rows),
    emitMessageReceived: (msg) => emitMessageReceived(msg),
    setHistoryId: async (historyId) => {
      await updateGmailHistoryId(params.credentialId, historyId)
    },
  }
}

/**
 * Exact `ContactEmail.email` match within the org (never a domain heuristic —
 * that misroutes when contacts share a domain). Earliest-appearing email wins.
 */
export async function resolveContact(
  orgId: string,
  emails: string[],
): Promise<ThreadContactMatch | null> {
  if (emails.length === 0) return null
  const rows = await prisma.contactEmail.findMany({
    where: { email: { in: emails }, contact: { organizationId: orgId } },
    select: { email: true, contact: { select: { id: true, leadId: true } } },
  })
  if (rows.length === 0) return null

  const rank = new Map(emails.map((e, i) => [e, i]))
  rows.sort(
    (a, b) => (rank.get(a.email) ?? Infinity) - (rank.get(b.email) ?? Infinity),
  )
  const top = rows[0]
  return { contactId: top.contact.id, leadId: top.contact.leadId }
}

/**
 * Upsert EmailThread by providerThreadId. `syncThread` always re-fetches the full
 * thread, so the aggregate is complete and we overwrite the denormalized fields.
 * We do NOT clobber a non-null contactId/leadId with null (a later reconcile job
 * may have linked a thread the sync couldn't).
 */
export async function upsertThread(
  orgId: string,
  agg: ThreadAggregate,
): Promise<{ id: string }> {
  const thread = await prisma.emailThread.upsert({
    where: { providerThreadId: agg.providerThreadId },
    create: {
      organizationId: orgId,
      providerThreadId: agg.providerThreadId,
      subject: agg.subject,
      participants: agg.participants,
      firstMessageAt: agg.firstMessageAt,
      lastMessageAt: agg.lastMessageAt,
      messageCount: agg.messageCount,
      contactId: agg.contactId,
      leadId: agg.leadId,
    },
    update: {
      subject: agg.subject,
      participants: agg.participants,
      firstMessageAt: agg.firstMessageAt,
      lastMessageAt: agg.lastMessageAt,
      messageCount: agg.messageCount,
      ...(agg.contactId
        ? { contactId: agg.contactId, leadId: agg.leadId }
        : {}),
    },
    select: { id: true },
  })
  return { id: thread.id }
}

/**
 * Insert messages idempotently (createMany + skipDuplicates on the unique
 * providerMessageId), returning the providerMessageIds actually inserted so the
 * caller emits `message.received` for new inbound only. Pre-selecting existing
 * ids lets us report the delta; skipDuplicates is the authoritative dedup.
 */
export async function saveMessages(
  orgId: string,
  rows: PersistableMessage[],
): Promise<{ insertedIds: string[] }> {
  if (rows.length === 0) return { insertedIds: [] }

  const ids = rows.map((r) => r.providerMessageId)
  const existing = await prisma.message.findMany({
    where: { providerMessageId: { in: ids } },
    select: { providerMessageId: true },
  })
  const existingSet = new Set(existing.map((e) => e.providerMessageId))
  const toInsert = rows.filter((r) => !existingSet.has(r.providerMessageId))

  if (toInsert.length > 0) {
    await prisma.message.createMany({
      data: toInsert.map((r) => ({
        organizationId: orgId,
        leadId: r.leadId,
        contactId: r.contactId,
        channel: r.channel,
        direction: r.direction,
        status: r.status,
        threadId: r.threadDbId,
        fromAddress: r.fromAddress,
        toAddresses: r.toAddresses,
        ccAddresses: r.ccAddresses,
        bccAddresses: r.bccAddresses,
        subject: r.subject,
        bodyText: r.bodyText,
        bodyHtml: r.bodyHtml,
        providerMessageId: r.providerMessageId,
        activityAt: r.activityAt,
      })),
      skipDuplicates: true,
    })
  }
  return { insertedIds: toInsert.map((r) => r.providerMessageId) }
}

/** Look up the freshly-inserted row's id and NOTIFY crm_message. */
export async function emitMessageReceived(msg: PersistableMessage): Promise<void> {
  const row = await prisma.message.findUnique({
    where: { providerMessageId: msg.providerMessageId },
    select: { id: true },
  })
  if (!row) return
  await notifyMessageReceived({
    messageId: row.id,
    channel: msg.channel,
    contactId: msg.contactId ?? undefined,
    leadId: msg.leadId ?? undefined,
    correlationId: getCorrelationId() ?? 'gmail-sync',
  })
}
