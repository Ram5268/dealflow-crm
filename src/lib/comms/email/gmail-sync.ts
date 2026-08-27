import type { ParsedEmail } from './parse'
import {
  aggregateThread,
  candidateEmails,
  directionFor,
  type ThreadAggregate,
  type ThreadContactMatch,
} from './thread-reconstruct'

/**
 * Gmail sync orchestration (brief §2.2 / §2.5).
 *
 * Backfill and delta share one path (`syncThread`): fetch a thread's full message
 * set, reconstruct the EmailThread, persist messages idempotently, and emit
 * `message.received` for NEWLY-inserted INCOMING messages only. All I/O is behind
 * `SyncPorts`, so the control flow — including the "advance the historyId cursor
 * only after a successful batch" invariant (never lose a message) and sent-mail
 * dedup — is unit-tested with in-memory fakes. The Prisma/Gmail adapter that
 * implements these ports lives alongside (see `createGmailSyncPorts`).
 */

/** A Message row ready to persist. */
export interface PersistableMessage {
  providerMessageId: string
  providerThreadId: string
  threadDbId: string
  channel: 'email'
  direction: 'incoming' | 'outgoing'
  status: string // 'inbox' (incoming) | 'sent' (own synced sent copy)
  fromAddress: string
  toAddresses: string[]
  ccAddresses: string[]
  bccAddresses: string[]
  subject?: string
  bodyText?: string
  bodyHtml?: string
  activityAt: Date
  contactId: string | null
  leadId: string | null
}

export interface SyncPorts {
  /** The connected mailbox address — decides message direction. */
  connectedEmail: string
  /** Raw Gmail thread ids matching a query (adapter paginates). */
  listThreadIds(query: string): Promise<string[]>
  /** All parsed messages of a thread. */
  getThreadMessages(threadId: string): Promise<ParsedEmail[]>
  /** Threads changed since a historyId + the newest historyId seen (delta). */
  listChangedThreadIds(startHistoryId: string): Promise<{
    threadIds: string[]
    latestHistoryId?: string
  }>
  /** Resolve the owning contact/lead from ordered participant emails (DB lookup). */
  resolveContact(orderedEmails: string[]): Promise<ThreadContactMatch | null>
  /** Upsert an EmailThread by providerThreadId (adapter MERGES on conflict). */
  upsertThread(agg: ThreadAggregate): Promise<{ id: string }>
  /** createMany({ skipDuplicates }); returns providerMessageIds actually inserted. */
  saveMessages(rows: PersistableMessage[]): Promise<{ insertedIds: string[] }>
  /** NOTIFY crm_message for one inbound message. */
  emitMessageReceived(msg: PersistableMessage): Promise<void>
  /** Persist the delta cursor (called only after a batch succeeds). */
  setHistoryId(historyId: string): Promise<void>
}

function toPersistable(
  p: ParsedEmail,
  agg: ThreadAggregate,
  threadDbId: string,
  connectedEmail: string,
): PersistableMessage {
  const direction = directionFor(p, connectedEmail)
  return {
    providerMessageId: p.providerMessageId,
    providerThreadId: p.providerThreadId,
    threadDbId,
    channel: 'email',
    direction,
    status: direction === 'incoming' ? 'inbox' : 'sent',
    fromAddress: p.fromAddress,
    toAddresses: p.toAddresses,
    ccAddresses: p.ccAddresses,
    bccAddresses: p.bccAddresses,
    subject: p.subject,
    bodyText: p.bodyText,
    bodyHtml: p.bodyHtml,
    activityAt: p.date,
    contactId: agg.contactId,
    leadId: agg.leadId,
  }
}

async function syncThread(
  ports: SyncPorts,
  threadId: string,
): Promise<{ inserted: number; emitted: number }> {
  const parsed = await ports.getThreadMessages(threadId)
  if (parsed.length === 0) return { inserted: 0, emitted: 0 }

  // Resolve the owning contact once (async DB lookup) then feed it into the pure
  // aggregate as a trivial sync resolver.
  const match = await ports.resolveContact(candidateEmails(parsed))
  const agg = aggregateThread(parsed, () => match)
  const { id: threadDbId } = await ports.upsertThread(agg)
  const rows = parsed.map((p) => toPersistable(p, agg, threadDbId, ports.connectedEmail))

  const { insertedIds } = await ports.saveMessages(rows)
  const inserted = new Set(insertedIds)

  let emitted = 0
  for (const row of rows) {
    // Emit only for messages we actually inserted (dedup) and that are inbound —
    // the user's own sent copies (outgoing) never fan out as message.received.
    if (inserted.has(row.providerMessageId) && row.direction === 'incoming') {
      await ports.emitMessageReceived(row)
      emitted++
    }
  }
  return { inserted: insertedIds.length, emitted }
}

export interface SyncResult {
  threads: number
  messagesInserted: number
  emitted: number
  historyId?: string
}

/** Initial backfill: walk threads matching `after:<sinceIso>`. */
export async function fullBackfill(
  ports: SyncPorts,
  sinceIso: string,
): Promise<SyncResult> {
  const threadIds = await ports.listThreadIds(`after:${sinceIso}`)
  let messagesInserted = 0
  let emitted = 0
  for (const threadId of threadIds) {
    const r = await syncThread(ports, threadId)
    messagesInserted += r.inserted
    emitted += r.emitted
  }
  return { threads: threadIds.length, messagesInserted, emitted }
}

/** Delta sync from a historyId. Advances the cursor ONLY after the batch succeeds. */
export async function deltaSync(
  ports: SyncPorts,
  startHistoryId: string,
): Promise<SyncResult> {
  const { threadIds, latestHistoryId } =
    await ports.listChangedThreadIds(startHistoryId)

  let messagesInserted = 0
  let emitted = 0
  for (const threadId of threadIds) {
    const r = await syncThread(ports, threadId)
    messagesInserted += r.inserted
    emitted += r.emitted
  }

  // Never lose a message: only persist the new cursor after everything above
  // succeeded. A throw anywhere leaves the old historyId in place for retry.
  if (latestHistoryId) await ports.setHistoryId(latestHistoryId)

  return {
    threads: threadIds.length,
    messagesInserted,
    emitted,
    historyId: latestHistoryId,
  }
}
