import type { ParsedEmail } from './parse'

/**
 * EmailThread reconstruction (brief §2.3, Gate-3 critical path #1).
 *
 * Gmail already threads messages, so `providerThreadId` (Gmail's threadId) is the
 * authoritative grouping key — we never re-derive threads from In-Reply-To/
 * References headers (that's how thread merges/splits get mishandled). Given the
 * messages of ONE thread, `aggregateThread` computes the EmailThread's
 * denormalized fields and resolves the owning contact/lead.
 *
 * Pure: contact resolution is injected as `resolveContact`, so every edge case
 * (forwards, unknown-participant replies, BCC replies, exact-vs-domain matching)
 * is testable without a database. The DB adapter passes a resolver that does an
 * EXACT `ContactEmail.email` lookup (never a domain heuristic — that misroutes).
 */

export interface ThreadContactMatch {
  contactId: string
  leadId: string
}

/**
 * Resolve a contact from candidate emails presented in chronological order.
 * Should return the FIRST email that maps to a contact (earliest message wins),
 * or null if none match.
 */
export type ContactResolver = (
  orderedEmails: string[],
) => ThreadContactMatch | null

export interface ThreadAggregate {
  providerThreadId: string
  subject: string
  participants: string[]
  firstMessageAt: Date
  lastMessageAt: Date
  messageCount: number
  contactId: string | null
  leadId: string | null
}

function dedupePreserveOrder(values: string[]): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const v of values) {
    if (v && !seen.has(v)) {
      seen.add(v)
      out.push(v)
    }
  }
  return out
}

/**
 * Aggregate one thread's messages into an EmailThread shape. `messages` must all
 * share a `providerThreadId` (Gmail's threadId); throws otherwise, since mixing
 * threads would corrupt the aggregate.
 */
export function aggregateThread(
  messages: ParsedEmail[],
  resolveContact: ContactResolver,
): ThreadAggregate {
  if (messages.length === 0) {
    throw new Error('aggregateThread: no messages')
  }
  const providerThreadId = messages[0].providerThreadId
  if (messages.some((m) => m.providerThreadId !== providerThreadId)) {
    throw new Error('aggregateThread: messages span multiple providerThreadIds')
  }

  const chrono = [...messages].sort((a, b) => a.date.getTime() - b.date.getTime())

  // participants = union of from + to + cc across the thread (BCC excluded — a
  // BCC recipient only becomes a participant once they reply and appear in From).
  const participants = dedupePreserveOrder(
    chrono.flatMap((m) => [m.fromAddress, ...m.toAddresses, ...m.ccAddresses]),
  ).filter(Boolean)

  // Contact-resolution candidates in chronological appearance order so the
  // earliest-matching message wins.
  const candidateEmails = dedupePreserveOrder(
    chrono.flatMap((m) => [m.fromAddress, ...m.toAddresses, ...m.ccAddresses]),
  ).filter(Boolean)
  const match = resolveContact(candidateEmails)

  return {
    providerThreadId,
    subject: chrono[0].subject ?? '',
    participants,
    firstMessageAt: chrono[0].date,
    lastMessageAt: chrono[chrono.length - 1].date,
    messageCount: chrono.length,
    contactId: match?.contactId ?? null,
    leadId: match?.leadId ?? null,
  }
}

/**
 * Direction of a message relative to the connected mailbox: mail FROM the
 * connected account is outgoing (its own sent copy), everything else incoming.
 * Drives which messages emit `message.received` (incoming only).
 */
export function directionFor(
  message: ParsedEmail,
  connectedEmail: string,
): 'incoming' | 'outgoing' {
  return message.fromAddress.toLowerCase() === connectedEmail.toLowerCase()
    ? 'outgoing'
    : 'incoming'
}
