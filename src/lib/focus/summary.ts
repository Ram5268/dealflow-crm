// Server-only by construction: imported solely from Server Components. Mirrors
// the boundary convention established by @/lib/leads/list — the `@/lib/prisma`
// import would fail in a client bundle.
import { DateTime } from 'luxon'
import { prisma } from '@/lib/prisma'
import { DISPLAY_TZ_FALLBACK, getQueue } from '@/lib/core-data/smart-view/queue-service'

/**
 * The Focus view's clock. "Today" has to be the user's day, not UTC's — a
 * 9pm ET call belongs to today, and UTC would file it under tomorrow.
 */
export const FOCUS_TZ = DISPLAY_TZ_FALLBACK

/**
 * Matches the limit /queue already passes, so the Focus count and the queue
 * page never disagree. getQueue compliance-scrubs a candidate pool five times
 * this size, which is why the panel is streamed behind its own Suspense
 * boundary rather than blocking the page.
 */
export const DIAL_QUEUE_LIMIT = 50

/** Dispositions that mean nobody was actually reached. */
const UNREACHED_DISPOSITIONS = ['no-answer', 'busy', 'vm-answer', 'vm-left', 'abandoned'] as const

export function dayWindow(now: Date = new Date()): { start: Date; end: Date } {
  const start = DateTime.fromJSDate(now).setZone(FOCUS_TZ).startOf('day')
  return { start: start.toJSDate(), end: start.plus({ days: 1 }).toJSDate() }
}

/** First non-empty line of a message body, trimmed for a one-line preview. */
export function previewOf(bodyText: string | null, max = 120): string {
  if (!bodyText) return ''
  const line = bodyText
    .split('\n')
    .map((l) => l.trim())
    .find((l) => l.length > 0)
  if (!line) return ''
  return line.length > max ? line.slice(0, max - 1) + '…' : line
}

/** Bulk lead-name lookup. Call and Message hold `leadId` without a relation. */
async function leadNames(ids: Array<string | null>): Promise<Map<string, string>> {
  const unique = [...new Set(ids.filter((id): id is string => Boolean(id)))]
  if (unique.length === 0) return new Map()
  const rows = await prisma.lead.findMany({
    where: { id: { in: unique } },
    select: { id: true, displayName: true },
  })
  return new Map(rows.map((r) => [r.id, r.displayName]))
}

// ---------------------------------------------------------------- dial queue

export interface DialQueuePanel {
  kind: 'ok'
  viewId: string
  viewName: string
  readyCount: number
  /** True when the count is limit-capped, so the UI can render "50+". */
  atCap: boolean
  excludedCompliance: number
  excludedNoPhone: number
}

export type DialQueueResult =
  | DialQueuePanel
  | { kind: 'no-view' }
  | { kind: 'error'; message: string }

export async function getDialQueue(organizationId: string): Promise<DialQueueResult> {
  const view = await prisma.savedView.findFirst({
    where: { organizationId, type: 'lead' },
    orderBy: { updatedAt: 'desc' },
    select: { id: true, name: true },
  })
  if (!view) return { kind: 'no-view' }

  try {
    const queue = await getQueue(view.id, organizationId, { limit: DIAL_QUEUE_LIMIT })
    return {
      kind: 'ok',
      viewId: view.id,
      viewName: view.name,
      readyCount: queue.leads.length,
      atCap: queue.leads.length >= DIAL_QUEUE_LIMIT,
      excludedCompliance: queue.excludedCompliance,
      excludedNoPhone: queue.excludedNoPhone,
    }
  } catch (err) {
    // Compliance is fail-closed upstream; surface that rather than a bare zero,
    // which would read as "nobody to call" instead of "we could not check".
    return { kind: 'error', message: err instanceof Error ? err.message : 'Queue unavailable' }
  }
}

// --------------------------------------------------------------- calls today

export interface CallItem {
  id: string
  leadId: string | null
  leadName: string
  at: Date
  disposition: string | null
  direction: string
}

export interface CallsTodayPanel {
  count: number
  recent: CallItem[]
}

export async function getCallsToday(
  organizationId: string,
  now: Date = new Date(),
): Promise<CallsTodayPanel> {
  const { start, end } = dayWindow(now)
  const where = { organizationId, activityAt: { gte: start, lt: end } }

  const [count, rows] = await Promise.all([
    prisma.call.count({ where }),
    prisma.call.findMany({
      where,
      orderBy: { activityAt: 'desc' },
      take: 3,
      select: { id: true, leadId: true, activityAt: true, disposition: true, direction: true },
    }),
  ])

  const names = await leadNames(rows.map((r) => r.leadId))
  return {
    count,
    recent: rows.map((r) => ({
      id: r.id,
      leadId: r.leadId,
      leadName: (r.leadId && names.get(r.leadId)) || 'Unknown lead',
      at: r.activityAt,
      disposition: r.disposition,
      direction: r.direction,
    })),
  }
}

// ------------------------------------------------------------- replies today

export interface ReplyItem {
  id: string
  leadId: string | null
  leadName: string
  channel: string
  preview: string
  at: Date
}

export interface RepliesTodayPanel {
  count: number
  recent: ReplyItem[]
}

export async function getRepliesToday(
  organizationId: string,
  now: Date = new Date(),
): Promise<RepliesTodayPanel> {
  const { start, end } = dayWindow(now)
  const where = {
    organizationId,
    direction: 'incoming',
    archivedAt: null,
    activityAt: { gte: start, lt: end },
  }

  const [count, rows] = await Promise.all([
    prisma.message.count({ where }),
    prisma.message.findMany({
      where,
      orderBy: { activityAt: 'desc' },
      take: 3,
      select: {
        id: true,
        leadId: true,
        channel: true,
        subject: true,
        bodyText: true,
        activityAt: true,
      },
    }),
  ])

  const names = await leadNames(rows.map((r) => r.leadId))
  return {
    count,
    recent: rows.map((r) => ({
      id: r.id,
      leadId: r.leadId,
      leadName: (r.leadId && names.get(r.leadId)) || 'Unknown lead',
      channel: r.channel,
      preview: previewOf(r.bodyText) || r.subject || '',
      at: r.activityAt,
    })),
  }
}

// ----------------------------------------------------------------- tasks due

export interface TaskItem {
  id: string
  text: string
  dueDate: Date | null
  leadId: string | null
  leadName: string | null
  overdue: boolean
}

export interface TasksDuePanel {
  count: number
  top: TaskItem[]
}

export async function getTasksDue(
  organizationId: string,
  now: Date = new Date(),
): Promise<TasksDuePanel> {
  const { start, end } = dayWindow(now)
  // Due today OR already overdue — both are work owed now. Dateless tasks are
  // excluded: they are a someday list, not today's obligation.
  const where = { organizationId, isComplete: false, dueDate: { lt: end } }

  const [count, rows] = await Promise.all([
    prisma.task.count({ where }),
    prisma.task.findMany({
      where,
      orderBy: { dueDate: 'asc' },
      take: 3,
      select: {
        id: true,
        text: true,
        dueDate: true,
        leadId: true,
        lead: { select: { displayName: true } },
      },
    }),
  ])

  return {
    count,
    top: rows.map((r) => ({
      id: r.id,
      text: r.text,
      dueDate: r.dueDate,
      leadId: r.leadId,
      leadName: r.lead?.displayName ?? null,
      overdue: r.dueDate ? r.dueDate < start : false,
    })),
  }
}

// ----------------------------------------------------------- needs attention

export type AttentionKind = 'reply' | 'task' | 'callback'

export interface AttentionItem {
  /** Namespaced so ids stay unique once three sources are interleaved. */
  key: string
  kind: AttentionKind
  title: string
  detail: string
  at: Date
  href: string
  overdue: boolean
}

export const ATTENTION_LIMIT = 10

/** How far back an unanswered reply or an unreached call still counts. */
const REPLY_LOOKBACK_DAYS = 14
const CALLBACK_LOOKBACK_DAYS = 7

/**
 * Urgency tiers. Higher wins; ties break oldest-first, because the thing that
 * has been waiting longest is the thing most likely to be dropped.
 */
function severityOf(kind: AttentionKind, overdue: boolean): number {
  if (kind === 'task') return overdue ? 3 : 2
  if (kind === 'reply') return 2
  return 1 // callback
}

export function rankAttention(items: AttentionItem[]): AttentionItem[] {
  return [...items].sort((a, b) => {
    const s = severityOf(b.kind, b.overdue) - severityOf(a.kind, a.overdue)
    if (s !== 0) return s
    return a.at.getTime() - b.at.getTime()
  })
}

/** Lead deep-link when we know the lead, otherwise the closest list surface. */
function leadHref(leadId: string | null, fallback: string): string {
  return leadId ? `/leads/${leadId}` : fallback
}

/**
 * The single "what needs me right now" list beneath the panels. Three sources,
 * one ranking:
 *
 *  - reply    — an incoming message nobody has read yet
 *  - task     — an incomplete task due today or overdue
 *  - callback — an outbound call that never reached a human, with no later
 *               answered call to the same lead. Agent B only places outbound
 *               calls today, so "missed" means "we dialed and did not connect".
 */
export async function getNeedsAttention(
  organizationId: string,
  now: Date = new Date(),
): Promise<AttentionItem[]> {
  const { start, end } = dayWindow(now)
  const replySince = DateTime.fromJSDate(now).minus({ days: REPLY_LOOKBACK_DAYS }).toJSDate()
  const callSince = DateTime.fromJSDate(now).minus({ days: CALLBACK_LOOKBACK_DAYS }).toJSDate()
  const pool = ATTENTION_LIMIT * 2

  const [replies, tasks, unreached] = await Promise.all([
    prisma.message.findMany({
      where: {
        organizationId,
        direction: 'incoming',
        readAt: null,
        archivedAt: null,
        activityAt: { gte: replySince },
      },
      orderBy: { activityAt: 'desc' },
      take: pool,
      select: {
        id: true,
        leadId: true,
        subject: true,
        bodyText: true,
        channel: true,
        activityAt: true,
      },
    }),
    prisma.task.findMany({
      where: { organizationId, isComplete: false, dueDate: { lt: end } },
      orderBy: { dueDate: 'asc' },
      take: pool,
      select: {
        id: true,
        text: true,
        dueDate: true,
        leadId: true,
        lead: { select: { displayName: true } },
      },
    }),
    prisma.call.findMany({
      where: {
        organizationId,
        activityAt: { gte: callSince },
        disposition: { in: [...UNREACHED_DISPOSITIONS] },
      },
      orderBy: { activityAt: 'desc' },
      take: pool * 4,
      select: { id: true, leadId: true, disposition: true, activityAt: true },
    }),
  ])

  // Drop a callback once a later call to the same lead actually connected.
  const candidateLeadIds = [...new Set(unreached.map((c) => c.leadId).filter(Boolean))] as string[]
  const answered = candidateLeadIds.length
    ? await prisma.call.findMany({
        where: {
          organizationId,
          leadId: { in: candidateLeadIds },
          disposition: 'answered',
          activityAt: { gte: callSince },
        },
        select: { leadId: true, activityAt: true },
      })
    : []
  const lastAnswered = new Map<string, number>()
  for (const a of answered) {
    if (!a.leadId) continue
    const prev = lastAnswered.get(a.leadId) ?? 0
    lastAnswered.set(a.leadId, Math.max(prev, a.activityAt.getTime()))
  }

  // One callback per lead — the most recent unreached attempt.
  const seenCallbackLeads = new Set<string>()
  const callbacks = unreached.filter((c) => {
    if (!c.leadId) return false
    if (seenCallbackLeads.has(c.leadId)) return false
    if ((lastAnswered.get(c.leadId) ?? 0) > c.activityAt.getTime()) return false
    seenCallbackLeads.add(c.leadId)
    return true
  })

  const names = await leadNames([
    ...replies.map((r) => r.leadId),
    ...callbacks.map((c) => c.leadId),
  ])

  const items: AttentionItem[] = [
    ...replies.map((r): AttentionItem => ({
      key: `reply:${r.id}`,
      kind: 'reply',
      title: (r.leadId && names.get(r.leadId)) || 'Unknown lead',
      detail: previewOf(r.bodyText) || r.subject || `New ${r.channel} message`,
      at: r.activityAt,
      href: leadHref(r.leadId, '/inbox'),
      overdue: false,
    })),
    ...tasks.map((t): AttentionItem => ({
      key: `task:${t.id}`,
      kind: 'task',
      title: t.lead?.displayName ?? 'No lead',
      detail: t.text,
      // Dateless tasks are filtered out by the query, so dueDate is present.
      at: t.dueDate ?? now,
      href: leadHref(t.leadId, '/leads'),
      overdue: t.dueDate ? t.dueDate < start : false,
    })),
    ...callbacks.map((c): AttentionItem => ({
      key: `callback:${c.id}`,
      kind: 'callback',
      title: (c.leadId && names.get(c.leadId)) || 'Unknown lead',
      detail: `No answer — ${c.disposition ?? 'not reached'}`,
      at: c.activityAt,
      href: leadHref(c.leadId, '/queue'),
      overdue: false,
    })),
  ]

  return rankAttention(items).slice(0, ATTENTION_LIMIT)
}
