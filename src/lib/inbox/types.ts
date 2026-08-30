/**
 * Shared inbox vocabulary. Kept free of Prisma so client components can import
 * the types and the pure filter helpers without dragging the DB into the bundle.
 */

export const INBOX_FILTERS = ['all', 'unread', 'email', 'sms', 'voicemail'] as const
export type InboxFilter = (typeof INBOX_FILTERS)[number]

export const FILTER_LABELS: Record<InboxFilter, string> = {
  all: 'All',
  unread: 'Unread',
  email: 'Email',
  sms: 'SMS',
  voicemail: 'Voicemail',
}

export type InboxChannel = 'email' | 'sms' | 'voicemail'

export function isInboxFilter(v: string | null | undefined): v is InboxFilter {
  return !!v && (INBOX_FILTERS as readonly string[]).includes(v)
}

/** One row in the left pane. `key` is the routable thread identity. */
export interface ThreadSummary {
  key: string
  channel: InboxChannel
  leadId: string | null
  title: string
  subject: string | null
  preview: string
  at: string
  unreadCount: number
  messageCount: number
  /** Every message in the thread — the archive target. Empty for voicemail. */
  messageIds: string[]
  /** Incoming messages only — the read/unread toggle target. */
  incomingIds: string[]
  /** The subset of `incomingIds` still unread; `unreadCount` is its length. */
  unreadIds: string[]
}

/** One entry in the right pane. Messages and voicemails render side by side. */
export interface ThreadItem {
  id: string
  kind: 'message' | 'voicemail'
  channel: InboxChannel
  direction: 'incoming' | 'outgoing'
  from: string
  to: string[]
  subject: string | null
  bodyText: string
  at: string
  readAt: string | null
  archivedAt: string | null
  /** Voicemail only. */
  audioUrl?: string | null
  durationSec?: number | null
  /** Outgoing only — Agent D's delivery state (outbox | scheduled | sent | error). */
  status?: string | null
}

export interface ThreadDetail {
  key: string
  channel: InboxChannel
  leadId: string | null
  title: string
  subject: string | null
  items: ThreadItem[]
  /** Best-known reply target for the composer. */
  replyToAddress: string | null
  replyToPhone: string | null
  contactId: string | null
}

/** Filters that are decided per-thread rather than in SQL. */
export function threadMatchesFilter(t: ThreadSummary, filter: InboxFilter): boolean {
  switch (filter) {
    case 'all':
      return true
    case 'unread':
      return t.unreadCount > 0
    case 'email':
    case 'sms':
    case 'voicemail':
      return t.channel === filter
  }
}

/** localStorage key for the remembered filter tab. */
export const FILTER_STORAGE_KEY = 'dealflow.inbox.filter'
