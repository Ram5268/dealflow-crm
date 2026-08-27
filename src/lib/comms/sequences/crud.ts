import { z } from 'zod'
import { prisma } from '../../prisma'

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

export async function updateSequence(orgId: string, id: string, input: unknown) {
  const data = sequenceInputSchema.partial().parse(input)
  return prisma.sequence.updateMany({
    where: { id, organizationId: orgId },
    data: {
      ...(data.name !== undefined ? { name: data.name } : {}),
      ...(data.description !== undefined ? { description: data.description } : {}),
      ...(data.channel !== undefined ? { channel: data.channel } : {}),
      ...(data.blackoutDates !== undefined ? { blackoutDates: data.blackoutDates } : {}),
    },
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
