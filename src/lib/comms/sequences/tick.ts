import { prisma } from '../../prisma'
import { logger } from '../../logger'
import { render } from '../templates/render'
import { resolveDueAt, DEFAULT_TIMEZONE } from './schedule'
import { emailEnabled } from '../email/config'

/**
 * Sequence tick (brief §3.4). Runs every ~15 min. For each ACTIVE enrollment:
 * compute the current step's due time (delay sum + blackout deferral, contact-
 * local TZ), and if due, render the step's template, insert an outbox Message,
 * enqueue the send, and advance to the next step (or finish). Each enrollment is
 * isolated — one failure marks only that enrollment `error` and doesn't block the
 * rest. `now` + `enqueueSend` are injectable so this tests without a clock or
 * pg-boss.
 */
export interface TickDeps {
  now?: Date
  enqueueSend?: (messageId: string) => Promise<void>
}

export interface TickResult {
  processed: number
  sent: number
  finished: number
  errored: number
  skipped?: 'email_disabled'
}

async function defaultEnqueue(messageId: string): Promise<void> {
  const [{ getBoss }, { QUEUES }] = await Promise.all([
    import('../jobs/boss'),
    import('../jobs/queues'),
  ])
  const boss = await getBoss()
  await boss.send(QUEUES.SEND_EMAIL, { messageId })
}

async function finish(enrollmentId: string, now: Date): Promise<void> {
  await prisma.sequenceEnrollment.update({
    where: { id: enrollmentId },
    data: { status: 'finished', finishedAt: now, currentStepId: null },
  })
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Enrollment = any

async function processEnrollment(
  enr: Enrollment,
  now: Date,
  enqueue: (id: string) => Promise<void>,
): Promise<'sent' | 'finished' | 'waiting'> {
  const steps = [...enr.sequence.steps].sort((a, b) => a.ordinal - b.ordinal)
  if (steps.length === 0 || !enr.currentStepId) {
    await finish(enr.id, now)
    return 'finished'
  }

  const idx = steps.findIndex((s) => s.id === enr.currentStepId)
  if (idx === -1) {
    throw new Error(`current step ${enr.currentStepId} not found in sequence ${enr.sequenceId}`)
  }
  const step = steps[idx]

  const contact = await prisma.contact.findUnique({
    where: { id: enr.contactId },
    select: { id: true, leadId: true, timezone: true },
  })
  const tz = contact?.timezone ?? DEFAULT_TIMEZONE

  const dueAt = resolveDueAt({
    enrolledAt: enr.enrolledAt,
    steps,
    currentStepId: enr.currentStepId,
    blackoutDates: enr.sequence.blackoutDates ?? [],
    contactTimezone: tz,
  })
  if (dueAt.toMillis() > now.getTime()) return 'waiting'

  const template = await prisma.messageTemplate.findUnique({ where: { id: step.templateId } })
  if (!template) {
    throw new Error(`template ${step.templateId} not found for step ${step.id}`)
  }

  const ctx = { orgId: enr.organizationId, contactId: contact?.id, leadId: contact?.leadId }
  const [bodyText, bodyHtml, subject] = await Promise.all([
    render(template.bodyText, ctx),
    template.bodyHtml ? render(template.bodyHtml, { ...ctx, html: true }) : Promise.resolve(null),
    template.subject ? render(template.subject, ctx) : Promise.resolve(null),
  ])

  const msg = await prisma.message.create({
    data: {
      organizationId: enr.organizationId,
      contactId: contact?.id ?? null,
      leadId: contact?.leadId ?? null,
      channel: step.channel,
      direction: 'outgoing',
      status: 'outbox',
      fromAddress: '',
      subject,
      bodyText,
      bodyHtml,
      templateId: template.id,
      sequenceId: enr.sequenceId,
      sequenceEnrollmentId: enr.id,
    },
  })
  await enqueue(msg.id)

  const next = steps[idx + 1]
  if (next) {
    await prisma.sequenceEnrollment.update({
      where: { id: enr.id },
      data: { currentStepId: next.id },
    })
  } else {
    await finish(enr.id, now)
  }
  return 'sent'
}

export async function runSequenceTick(deps: TickDeps = {}): Promise<TickResult> {
  // Brief 37: sequence steps send email. While email is off the tick does
  // nothing — no step advances and nothing is marked sent.
  if (!emailEnabled()) return { processed: 0, sent: 0, finished: 0, errored: 0, skipped: 'email_disabled' }

  const now = deps.now ?? new Date()
  const enqueue = deps.enqueueSend ?? defaultEnqueue

  const enrollments = await prisma.sequenceEnrollment.findMany({
    where: { status: 'active' },
    include: { sequence: { include: { steps: true } } },
  })

  const result: TickResult = { processed: 0, sent: 0, finished: 0, errored: 0 }
  for (const enr of enrollments) {
    result.processed++
    try {
      const action = await processEnrollment(enr, now, enqueue)
      if (action === 'sent') result.sent++
      else if (action === 'finished') result.finished++
    } catch (err) {
      logger.error({ err, enrollmentId: enr.id }, 'sequence tick: enrollment failed')
      await prisma.sequenceEnrollment
        .update({ where: { id: enr.id }, data: { status: 'error' } })
        .catch(() => {})
      result.errored++
    }
  }
  return result
}
