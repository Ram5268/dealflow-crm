// Server-only by construction: imported solely from Server Components, the same
// boundary convention as @/lib/leads/list and @/lib/focus/summary.
import { prisma } from '@/lib/prisma'
import { previewOf } from '@/lib/ui/text'
import {
  threadMatchesFilter,
  type InboxChannel,
  type InboxFilter,
  type ThreadDetail,
  type ThreadItem,
  type ThreadSummary,
} from './types'

/**
 * Threads are grouped in memory rather than in SQL. `threadId` is nullable, so a
 * GROUP BY would need a COALESCE over two shapes plus a lateral join to recover
 * each thread's newest row — for a single-seat MVP that is a lot of machinery to
 * maintain for a list that is capped at a few hundred rows anyway. The scan
 * window is explicit and the UI states it when it bites.
 */
export const THREAD_SCAN_LIMIT = 500

/** Namespaced so a message thread and a voicemail can never collide. */
export function messageThreadKey(m: { threadId: string | null; id: string }): string {
  return `m:${m.threadId ?? m.id}`
}
export function voicemailThreadKey(callId: string): string {
  return `v:${callId}`
}

function channelOf(raw: string): InboxChannel {
  return raw === 'sms' ? 'sms' : 'email'
}

function directionOf(raw: string): 'incoming' | 'outgoing' {
  return raw === 'incoming' ? 'incoming' : 'outgoing'
}

/** Bulk lead-name lookup — Message and Call hold `leadId` without a relation. */
async function leadNames(ids: Array<string | null>): Promise<Map<string, string>> {
  const unique = [...new Set(ids.filter((id): id is string => Boolean(id)))]
  if (unique.length === 0) return new Map()
  const rows = await prisma.lead.findMany({
    where: { id: { in: unique } },
    select: { id: true, displayName: true },
  })
  return new Map(rows.map((r) => [r.id, r.displayName]))
}

/** Human label for a thread when there is no lead to name it after. */
function titleFor(leadName: string | null, fallback: string): string {
  return leadName || fallback || 'Unknown sender'
}

// ------------------------------------------------------------------ listing

export interface ListThreadsResult {
  threads: ThreadSummary[]
  /** True when the scan window was full, so older threads exist but are unlisted. */
  truncated: boolean
}

/** The message fields grouping needs. Structural so tests need no Prisma. */
export interface GroupableMessage {
  id: string
  threadId: string | null
  leadId: string | null
  channel: string
  direction: string
  fromAddress: string
  subject: string | null
  bodyText: string | null
  activityAt: Date
  readAt: Date | null
}

export interface GroupableVoicemail {
  id: string
  leadId: string | null
  remotePhone: string
  activityAt: Date
  voicemailDurationSec: number | null
}

/**
 * Fold message rows and voicemail calls into one newest-first thread list.
 *
 * Pure and exported so the grouping rules — newest row represents the thread,
 * unread counts only incoming, voicemails never claim read state — are testable
 * without a database. `messages` MUST arrive newest-first; the first row seen
 * for a key is the one that names the thread.
 */
export function buildThreadSummaries(
  messages: GroupableMessage[],
  voicemails: GroupableVoicemail[],
  names: Map<string, string>,
): ThreadSummary[] {
  const byKey = new Map<string, ThreadSummary>()

  for (const m of messages) {
    const key = messageThreadKey(m)
    const existing = byKey.get(key)
    const incoming = m.direction === 'incoming'
    const unread = incoming && m.readAt === null
    if (existing) {
      existing.unreadCount += unread ? 1 : 0
      existing.messageCount += 1
      existing.messageIds.push(m.id)
      if (incoming) existing.incomingIds.push(m.id)
      if (unread) existing.unreadIds.push(m.id)
      continue
    }
    const leadName = m.leadId ? (names.get(m.leadId) ?? null) : null
    byKey.set(key, {
      key,
      channel: channelOf(m.channel),
      leadId: m.leadId,
      title: titleFor(leadName, m.fromAddress),
      subject: m.subject,
      preview: previewOf(m.bodyText) || m.subject || '',
      at: m.activityAt.toISOString(),
      unreadCount: unread ? 1 : 0,
      messageCount: 1,
      messageIds: [m.id],
      incomingIds: incoming ? [m.id] : [],
      unreadIds: unread ? [m.id] : [],
    })
  }

  for (const v of voicemails) {
    const leadName = v.leadId ? (names.get(v.leadId) ?? null) : null
    const secs = v.voicemailDurationSec
    byKey.set(voicemailThreadKey(v.id), {
      key: voicemailThreadKey(v.id),
      channel: 'voicemail',
      leadId: v.leadId,
      title: titleFor(leadName, v.remotePhone),
      subject: null,
      preview: secs ? `Voicemail · ${secs}s` : 'Voicemail',
      at: v.activityAt.toISOString(),
      // Calls carry no read state — only Message does. Voicemails therefore
      // never contribute to the unread badge, which is honest rather than a
      // fabricated flag on a table Agent E does not own.
      unreadCount: 0,
      messageCount: 1,
      messageIds: [],
      incomingIds: [],
      unreadIds: [],
    })
  }

  return [...byKey.values()].sort((a, b) => b.at.localeCompare(a.at))
}

export async function listThreads(
  organizationId: string,
  filter: InboxFilter = 'all',
): Promise<ListThreadsResult> {
  // Archived items leave the inbox entirely; the thread detail can still be
  // reached by URL, which is what makes archiving reversible rather than lossy.
  const messages = await prisma.message.findMany({
    where: { organizationId, archivedAt: null },
    orderBy: { activityAt: 'desc' },
    take: THREAD_SCAN_LIMIT,
    select: {
      id: true,
      threadId: true,
      leadId: true,
      channel: true,
      direction: true,
      fromAddress: true,
      subject: true,
      bodyText: true,
      activityAt: true,
      readAt: true,
    },
  })

  const voicemails = await prisma.call.findMany({
    where: { organizationId, voicemailUrl: { not: null } },
    orderBy: { activityAt: 'desc' },
    take: THREAD_SCAN_LIMIT,
    select: {
      id: true,
      leadId: true,
      remotePhone: true,
      activityAt: true,
      voicemailDurationSec: true,
    },
  })

  const names = await leadNames([
    ...messages.map((m) => m.leadId),
    ...voicemails.map((v) => v.leadId),
  ])

  const threads = buildThreadSummaries(messages, voicemails, names).filter((t) =>
    threadMatchesFilter(t, filter),
  )

  return { threads, truncated: messages.length >= THREAD_SCAN_LIMIT }
}

// ------------------------------------------------------------------- detail

export async function getThread(
  organizationId: string,
  key: string,
): Promise<ThreadDetail | null> {
  if (key.startsWith('v:')) return voicemailDetail(organizationId, key.slice(2))
  if (key.startsWith('m:')) return messageDetail(organizationId, key.slice(2))
  return null
}

async function messageDetail(organizationId: string, id: string): Promise<ThreadDetail | null> {
  // `id` is either a threadId shared by several messages or a lone message id.
  // Archived rows ARE included here: opening an archived thread by URL should
  // show it, otherwise archiving would look like deletion.
  const rows = await prisma.message.findMany({
    where: { organizationId, OR: [{ threadId: id }, { id }] },
    orderBy: { activityAt: 'asc' },
    select: {
      id: true,
      leadId: true,
      contactId: true,
      channel: true,
      direction: true,
      fromAddress: true,
      toAddresses: true,
      smsRemotePhone: true,
      subject: true,
      bodyText: true,
      bodyHtml: true,
      activityAt: true,
      readAt: true,
      archivedAt: true,
      status: true,
    },
  })
  if (rows.length === 0) return null

  const newest = rows[rows.length - 1]
  const leadName = newest.leadId
    ? ((await leadNames([newest.leadId])).get(newest.leadId) ?? null)
    : null

  const items: ThreadItem[] = rows.map((r) => ({
    id: r.id,
    kind: 'message',
    channel: channelOf(r.channel),
    direction: directionOf(r.direction),
    from: r.fromAddress,
    to: r.toAddresses,
    subject: r.subject,
    // bodyHtml is deliberately NOT rendered: injecting remote HTML into the app
    // origin is an XSS surface, and sanitising it properly is its own project.
    bodyText: r.bodyText ?? '',
    at: r.activityAt.toISOString(),
    readAt: r.readAt?.toISOString() ?? null,
    archivedAt: r.archivedAt?.toISOString() ?? null,
    status: r.status,
  }))

  // Reply to whoever last wrote in — falling back to the newest recipient when
  // the whole thread is outbound.
  //
  // Gated on channel: an SMS row stores the phone number in `fromAddress`, so
  // reading it as an email address makes an SMS thread look sendable as email.
  const lastIncoming = [...rows].reverse().find((r) => r.direction === 'incoming')
  const isEmail = channelOf(newest.channel) === 'email'
  const replyToAddress = isEmail ? lastIncoming?.fromAddress || newest.toAddresses[0] || null : null
  const replyToPhone =
    lastIncoming?.smsRemotePhone ||
    newest.smsRemotePhone ||
    (isEmail ? null : (lastIncoming?.fromAddress ?? null))

  return {
    key: `m:${id}`,
    channel: channelOf(newest.channel),
    leadId: newest.leadId,
    contactId: newest.contactId,
    title: titleFor(leadName, lastIncoming?.fromAddress ?? newest.fromAddress),
    subject: rows.find((r) => r.subject)?.subject ?? null,
    items,
    replyToAddress,
    replyToPhone,
  }
}

async function voicemailDetail(organizationId: string, callId: string): Promise<ThreadDetail | null> {
  const call = await prisma.call.findFirst({
    where: { id: callId, organizationId, voicemailUrl: { not: null } },
    select: {
      id: true,
      leadId: true,
      contactId: true,
      remotePhone: true,
      activityAt: true,
      voicemailUrl: true,
      voicemailDurationSec: true,
      direction: true,
    },
  })
  if (!call) return null

  const leadName = call.leadId
    ? ((await leadNames([call.leadId])).get(call.leadId) ?? null)
    : null

  return {
    key: voicemailThreadKey(call.id),
    channel: 'voicemail',
    leadId: call.leadId,
    contactId: call.contactId,
    title: titleFor(leadName, call.remotePhone),
    subject: null,
    items: [
      {
        id: call.id,
        kind: 'voicemail',
        channel: 'voicemail',
        direction: 'incoming',
        from: call.remotePhone,
        to: [],
        subject: null,
        bodyText: '',
        at: call.activityAt.toISOString(),
        readAt: null,
        archivedAt: null,
        audioUrl: call.voicemailUrl,
        durationSec: call.voicemailDurationSec,
      },
    ],
    // No voicemail-to-voicemail reply: a voicemail is answered by email or SMS,
    // and we only know the phone.
    replyToAddress: null,
    replyToPhone: call.remotePhone,
  }
}
