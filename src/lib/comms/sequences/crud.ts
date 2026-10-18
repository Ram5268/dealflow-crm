import { z } from 'zod'
import type { Prisma } from '@prisma/client'
import { prisma } from '../../prisma'
import { assertSequenceCanStart } from './channel-gate'

/** Sequence + step CRUD and enrollment (brief §3.3). */
export const stepInputSchema = z.object({
  ordinal: z.number().int(),
  delayHours: z.number().int().min(0),
  channel: z.enum(['email', 'sms']),
  templateId: z.string(),
})

export const sequenceInputSchema = z.object({
  name: z.string().min(1),
  description: z.string().nullish(),
  channel: z.enum(['email', 'sms', 'mixed']),
  blackoutDates: z.array(z.string()).optional(),
  steps: z.array(stepInputSchema).optional(),
})

export const enrollInputSchema = z.object({
  sequenceId: z.string(),
  contactId: z.string(),
})

export const enrollmentStatusSchema = z.object({
  status: z.enum(['paused', 'active', 'cancelled']),
})

export class SequenceStepInUseError extends Error {
  readonly code = 'sequence_step_in_use'
  constructor(readonly stepIds: string[]) {
    super('Cannot remove a step that an active enrollment is currently on')
    this.name = 'SequenceStepInUseError'
  }
}

export class DuplicateEnrollmentError extends Error {
  readonly code = 'duplicate_enrollment'
  constructor() {
    super('Contact already has an active enrollment in this sequence')
    this.name = 'DuplicateEnrollmentError'
  }
}

export async function createSequence(orgId: string, input: unknown) {
  const data = sequenceInputSchema.parse(input)
  return prisma.sequence.create({
    data: {
      organizationId: orgId,
      name: data.name,
      description: data.description ?? null,
      channel: data.channel,
      blackoutDates: data.blackoutDates ?? [],
      steps: data.steps
        ? {
            create: data.steps.map((s) => ({
              ordinal: s.ordinal,
              delayHours: s.delayHours,
              channel: s.channel,
              templateId: s.templateId,
            })),
          }
        : undefined,
    },
    include: { steps: { orderBy: { ordinal: 'asc' } } },
  })
}

export function listSequences(orgId: string) {
  return prisma.sequence.findMany({
    where: { organizationId: orgId },
    include: { steps: { orderBy: { ordinal: 'asc' } } },
    orderBy: { createdAt: 'desc' },
  })
}

export function getSequence(orgId: string, id: string) {
  return prisma.sequence.findFirst({
    where: { id, organizationId: orgId },
    include: { steps: { orderBy: { ordinal: 'asc' } } },
  })
}

export async function listSteps(orgId: string, sequenceId: string) {
  const seq = await getSequence(orgId, sequenceId)
  return seq?.steps ?? []
}

/**
 * Positionally reconcile a sequence's steps against the editor's full ordered
 * list.
 *
 * NOT delete-all-then-recreate: `SequenceEnrollment.currentStepId` is a plain
 * String with no FK, and `tick.ts` THROWS (`current step <id> not found in
 * sequence <id>`) when it cannot resolve that id against the step list. Fresh
 * ids would strand every active enrollment. So surviving positions are UPDATEd
 * in place, keeping their ids resolvable.
 *
 * Existing steps (ordinal-sorted) are matched positionally to the incoming
 * list: overlap is updated, the tail is deleted, extras are created. Removing a
 * step that an active enrollment currently sits on is refused
 * (`SequenceStepInUseError` -> 409) rather than silently stranding it.
 */
async function reconcileSteps(
  tx: Prisma.TransactionClient,
  sequenceId: string,
  next: z.infer<typeof stepInputSchema>[],
) {
  const existing = await tx.sequenceStep.findMany({
    where: { sequenceId },
    orderBy: { ordinal: 'asc' },
    select: { id: true },
  })

  const keep = existing.slice(0, next.length)
  const drop = existing.slice(next.length)

  if (drop.length > 0) {
    const dropIds = drop.map((s) => s.id)
    const stranded = await tx.sequenceEnrollment.findMany({
      where: { sequenceId, status: 'active', currentStepId: { in: dropIds } },
      select: { currentStepId: true },
    })
    if (stranded.length > 0) {
      throw new SequenceStepInUseError(dropIds)
    }
    await tx.sequenceStep.deleteMany({ where: { id: { in: dropIds } } })
  }

  for (let i = 0; i < keep.length; i++) {
    const s = next[i]
    await tx.sequenceStep.update({
      where: { id: keep[i].id },
      data: {
        ordinal: s.ordinal,
        delayHours: s.delayHours,
        channel: s.channel,
        templateId: s.templateId,
      },
    })
  }

  const add = next.slice(keep.length)
  if (add.length > 0) {
    await tx.sequenceStep.createMany({
      data: add.map((s) => ({
        sequenceId,
        ordinal: s.ordinal,
        delayHours: s.delayHours,
        channel: s.channel,
        templateId: s.templateId,
      })),
    })
  }
}

export async function updateSequence(orgId: string, id: string, input: unknown) {
  const data = sequenceInputSchema.partial().parse(input)
  return prisma.$transaction(async (tx) => {
    const res = await tx.sequence.updateMany({
      where: { id, organizationId: orgId },
      data: {
        ...(data.name !== undefined ? { name: data.name } : {}),
        ...(data.description !== undefined ? { description: data.description } : {}),
        ...(data.channel !== undefined ? { channel: data.channel } : {}),
        ...(data.blackoutDates !== undefined ? { blackoutDates: data.blackoutDates } : {}),
      },
    })
    // `steps: undefined` means "leave steps alone"; `steps: []` clears them.
    // Only reconcile once the org-scoped update proved the sequence is ours.
    if (res.count > 0 && data.steps !== undefined) {
      await reconcileSteps(tx, id, data.steps)
    }
    return res
  })
}

export function deleteSequence(orgId: string, id: string) {
  // Cascades steps + enrollments (schema onDelete: Cascade).
  return prisma.sequence.deleteMany({ where: { id, organizationId: orgId } })
}

export async function enrollContact(orgId: string, input: unknown) {
  const { sequenceId, contactId } = enrollInputSchema.parse(input)

  const seq = await prisma.sequence.findFirst({
    where: { id: sequenceId, organizationId: orgId },
    include: { steps: { orderBy: { ordinal: 'asc' } } },
  })
  if (!seq) throw new Error('enrollContact: sequence not found')

  // Brief 41.2 (PR E): no enrollment while a channel this sequence uses is off,
  // refused before anything is written. Every enrollment is created here, so
  // every caller gets it. Engineering precaution (audit H15); see channel-gate.
  assertSequenceCanStart(seq)

  const contact = await prisma.contact.findFirst({ where: { id: contactId, organizationId: orgId } })
  if (!contact) throw new Error('enrollContact: contact not found')

  const existing = await prisma.sequenceEnrollment.findFirst({
    where: { sequenceId, contactId, status: 'active' },
  })
  if (existing) throw new DuplicateEnrollmentError()

  return prisma.sequenceEnrollment.create({
    data: {
      organizationId: orgId,
      sequenceId,
      contactId,
      status: 'active',
      currentStepId: seq.steps[0]?.id ?? null,
    },
  })
}

export async function updateEnrollment(orgId: string, id: string, input: unknown) {
  const { status } = enrollmentStatusSchema.parse(input)
  return prisma.sequenceEnrollment.updateMany({
    where: { id, organizationId: orgId },
    data: { status },
  })
}
