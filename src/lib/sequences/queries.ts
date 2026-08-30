// Server-only by construction: imported solely from Server Components, the same
// boundary convention as @/lib/leads/list, @/lib/focus/summary, @/lib/inbox.
//
// Reads layer on top of Agent D's CRUD (`@/lib/comms/sequences/crud`) rather
// than replacing it: D owns writes and validation, this file only derives the
// counts the list and detail views need, which D's schema does not store.
import { prisma } from '@/lib/prisma'
import { listSequences } from '@/lib/comms/sequences/crud'

/**
 * `Sequence` has NO status column — active/paused lives on SequenceEnrollment.
 * So a sequence is "Active" when something is currently running through it and
 * "Idle" otherwise. Deliberately not called "Paused": nothing can pause a
 * sequence itself, and saying so would invent a control that does not exist.
 */
export type SequenceActivity = 'active' | 'idle'

export interface SequenceRow {
  id: string
  name: string
  description: string | null
  channel: string
  stepCount: number
  activeEnrollments: number
  totalEnrollments: number
  activity: SequenceActivity
  /** Newest sequence-sent message, else newest enrollment. Null if neither. */
  lastActivityAt: string | null
  createdAt: string
}

export async function listSequenceRows(organizationId: string): Promise<SequenceRow[]> {
  const sequences = await listSequences(organizationId)
  if (sequences.length === 0) return []
  const ids = sequences.map((s) => s.id)

  const [enrollments, lastMessages, lastEnrollments] = await Promise.all([
    prisma.sequenceEnrollment.groupBy({
      by: ['sequenceId', 'status'],
      where: { organizationId, sequenceId: { in: ids } },
      _count: { _all: true },
    }),
    prisma.message.groupBy({
      by: ['sequenceId'],
      where: { organizationId, sequenceId: { in: ids } },
      _max: { activityAt: true },
    }),
    prisma.sequenceEnrollment.groupBy({
      by: ['sequenceId'],
      where: { organizationId, sequenceId: { in: ids } },
      _max: { enrolledAt: true },
    }),
  ])

  const activeBySeq = new Map<string, number>()
  const totalBySeq = new Map<string, number>()
  for (const row of enrollments) {
    const n = row._count._all
    totalBySeq.set(row.sequenceId, (totalBySeq.get(row.sequenceId) ?? 0) + n)
    if (row.status === 'active') activeBySeq.set(row.sequenceId, (activeBySeq.get(row.sequenceId) ?? 0) + n)
  }
  const msgAt = new Map(lastMessages.map((m) => [m.sequenceId as string, m._max.activityAt]))
  const enrAt = new Map(lastEnrollments.map((e) => [e.sequenceId, e._max.enrolledAt]))

  return sequences.map((s) => {
    const active = activeBySeq.get(s.id) ?? 0
    const last = msgAt.get(s.id) ?? enrAt.get(s.id) ?? null
    return {
      id: s.id,
      name: s.name,
      description: s.description,
      channel: s.channel,
      stepCount: s.steps.length,
      activeEnrollments: active,
      totalEnrollments: totalBySeq.get(s.id) ?? 0,
      activity: active > 0 ? 'active' : 'idle',
      lastActivityAt: last ? last.toISOString() : null,
      createdAt: s.createdAt.toISOString(),
    }
  })
}

// ------------------------------------------------------------------ detail

export interface SequenceStepRow {
  id: string
  ordinal: number
  delayHours: number
  channel: string
  templateId: string
  templateName: string | null
  templateSubject: string | null
  templatePreview: string
}

export interface EnrollmentRow {
  id: string
  contactId: string
  contactName: string
  leadId: string | null
  status: string
  currentStepOrdinal: number | null
  enrolledAt: string
  /** Derived: enrolledAt + the cumulative delay up to the current step. */
  nextFireAt: string | null
}

export interface SequenceStats {
  sent: number
  failed: number
  queued: number
  replies: number
  /** Nothing in the schema records opens or bounces — see audit §12. */
  openRate: null
  bounceRate: null
}

export interface SequenceDetail {
  id: string
  name: string
  description: string | null
  channel: string
  createdAt: string
  steps: SequenceStepRow[]
  enrollments: EnrollmentRow[]
  stats: SequenceStats
}

export async function getSequenceDetail(
  organizationId: string,
  id: string,
): Promise<SequenceDetail | null> {
  const seq = await prisma.sequence.findFirst({
    where: { id, organizationId },
    include: { steps: { orderBy: { ordinal: 'asc' } } },
  })
  if (!seq) return null

  const templateIds = [...new Set(seq.steps.map((s) => s.templateId))]
  const [templates, enrollments, messageCounts] = await Promise.all([
    templateIds.length
      ? prisma.messageTemplate.findMany({
          where: { id: { in: templateIds }, organizationId },
          select: { id: true, name: true, subject: true, bodyText: true },
        })
      : Promise.resolve([]),
    prisma.sequenceEnrollment.findMany({
      where: { organizationId, sequenceId: id },
      orderBy: { enrolledAt: 'desc' },
      take: 200,
    }),
    prisma.message.groupBy({
      by: ['status'],
      where: { organizationId, sequenceId: id },
      _count: { _all: true },
    }),
  ])

  const tById = new Map(templates.map((t) => [t.id, t]))
  const steps: SequenceStepRow[] = seq.steps.map((s) => {
    const t = tById.get(s.templateId)
    return {
      id: s.id,
      ordinal: s.ordinal,
      delayHours: s.delayHours,
      channel: s.channel,
      templateId: s.templateId,
      // A step's template can be missing if it was removed out from under it;
      // say so rather than rendering a blank row.
      templateName: t?.name ?? null,
      templateSubject: t?.subject ?? null,
      templatePreview: (t?.bodyText ?? '').slice(0, 140),
    }
  })

  const contactIds = [...new Set(enrollments.map((e) => e.contactId))]
  const contacts = contactIds.length
    ? await prisma.contact.findMany({
        where: { id: { in: contactIds } },
        select: { id: true, displayName: true, leadId: true },
      })
    : []
  const cById = new Map(contacts.map((c) => [c.id, c]))
  const stepById = new Map(seq.steps.map((s) => [s.id, s]))
  // Cumulative delay to the START of each ordinal.
  const cumulative = new Map<number, number>()
  let running = 0
  for (const s of seq.steps) {
    running += s.delayHours
    cumulative.set(s.ordinal, running)
  }

  const enrollmentRows: EnrollmentRow[] = enrollments.map((e) => {
    const c = cById.get(e.contactId)
    const step = e.currentStepId ? stepById.get(e.currentStepId) : undefined
    const hours = step ? (cumulative.get(step.ordinal) ?? 0) : null
    return {
      id: e.id,
      contactId: e.contactId,
      contactName: c?.displayName ?? 'Unknown contact',
      leadId: c?.leadId ?? null,
      status: e.status,
      currentStepOrdinal: step?.ordinal ?? null,
      enrolledAt: e.enrolledAt.toISOString(),
      // Approximate by construction: the tick worker owns real scheduling, and
      // nothing persists a next-fire timestamp to read.
      nextFireAt:
        e.status === 'active' && hours !== null
          ? new Date(e.enrolledAt.getTime() + hours * 3600_000).toISOString()
          : null,
    }
  })

  const byStatus = new Map(messageCounts.map((m) => [m.status, m._count._all]))
  const replies = await prisma.message.count({
    where: {
      organizationId,
      direction: 'incoming',
      contactId: { in: contactIds.length ? contactIds : ['__none__'] },
    },
  })

  return {
    id: seq.id,
    name: seq.name,
    description: seq.description,
    channel: seq.channel,
    createdAt: seq.createdAt.toISOString(),
    steps,
    enrollments: enrollmentRows,
    stats: {
      sent: byStatus.get('sent') ?? 0,
      failed: byStatus.get('error') ?? 0,
      queued: (byStatus.get('outbox') ?? 0) + (byStatus.get('scheduled') ?? 0),
      replies,
      openRate: null,
      bounceRate: null,
    },
  }
}

// ---------------------------------------------------------------- templates

export interface TemplateRow {
  id: string
  name: string
  channel: string
  subject: string | null
  bodyText: string
  mergeFields: string[]
  /** Newest message that used this template. Null if never used. */
  lastUsedAt: string | null
  createdAt: string
}

export async function listTemplateRows(
  organizationId: string,
  channel?: string,
): Promise<TemplateRow[]> {
  const templates = await prisma.messageTemplate.findMany({
    where: { organizationId, ...(channel ? { channel } : {}) },
    orderBy: { createdAt: 'desc' },
  })
  if (templates.length === 0) return []

  // "Last used" is not a column — derive it from the messages that cite it.
  const used = await prisma.message.groupBy({
    by: ['templateId'],
    where: { organizationId, templateId: { in: templates.map((t) => t.id) } },
    _max: { activityAt: true },
  })
  const lastUsed = new Map(used.map((u) => [u.templateId as string, u._max.activityAt]))

  return templates.map((t) => ({
    id: t.id,
    name: t.name,
    channel: t.channel,
    subject: t.subject,
    bodyText: t.bodyText,
    mergeFields: t.mergeFields,
    lastUsedAt: lastUsed.get(t.id)?.toISOString() ?? null,
    createdAt: t.createdAt.toISOString(),
  }))
}
