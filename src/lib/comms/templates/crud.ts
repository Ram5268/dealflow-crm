import { z } from 'zod'
import { prisma } from '../../prisma'
import { extractMergeFields } from './render'

/** MessageTemplate CRUD (brief §3.1). Auto-extracts mergeFields from the body/subject. */
export const templateInputSchema = z.object({
  name: z.string().min(1),
  channel: z.enum(['email', 'sms']),
  subject: z.string().nullish(),
  bodyText: z.string().min(1),
  bodyHtml: z.string().nullish(),
})
export type TemplateInput = z.infer<typeof templateInputSchema>

export class TemplateInUseError extends Error {
  readonly code = 'template_in_use'
  constructor() {
    super('Template is referenced by a sequence step and cannot be deleted')
    this.name = 'TemplateInUseError'
  }
}

function mergeFieldsOf(parts: Array<string | null | undefined>): string[] {
  const set = new Set<string>()
  for (const p of parts) if (p) for (const f of extractMergeFields(p)) set.add(f)
  return [...set]
}

export async function createTemplate(orgId: string, input: unknown) {
  const data = templateInputSchema.parse(input)
  return prisma.messageTemplate.create({
    data: {
      organizationId: orgId,
      name: data.name,
      channel: data.channel,
      subject: data.subject ?? null,
      bodyText: data.bodyText,
      bodyHtml: data.bodyHtml ?? null,
      mergeFields: mergeFieldsOf([data.bodyText, data.bodyHtml, data.subject]),
    },
  })
}

export function listTemplates(orgId: string, channel?: string) {
  return prisma.messageTemplate.findMany({
    where: { organizationId: orgId, ...(channel ? { channel } : {}) },
    orderBy: { createdAt: 'desc' },
  })
}

export function getTemplate(orgId: string, id: string) {
  return prisma.messageTemplate.findFirst({ where: { id, organizationId: orgId } })
}

export async function updateTemplate(orgId: string, id: string, input: unknown) {
  const data = templateInputSchema.partial().parse(input)
  const current = await prisma.messageTemplate.findFirst({ where: { id, organizationId: orgId } })
  if (!current) return null
  const bodyText = data.bodyText ?? current.bodyText
  const bodyHtml = data.bodyHtml === undefined ? current.bodyHtml : data.bodyHtml
  const subject = data.subject === undefined ? current.subject : data.subject
  return prisma.messageTemplate.update({
    where: { id },
    data: {
      ...(data.name !== undefined ? { name: data.name } : {}),
      ...(data.channel !== undefined ? { channel: data.channel } : {}),
      subject,
      bodyText,
      bodyHtml,
      mergeFields: mergeFieldsOf([bodyText, bodyHtml, subject]),
    },
  })
}

export async function deleteTemplate(orgId: string, id: string) {
  const inUse = await prisma.sequenceStep.count({ where: { templateId: id } })
  if (inUse > 0) throw new TemplateInUseError()
  return prisma.messageTemplate.deleteMany({ where: { id, organizationId: orgId } })
}
