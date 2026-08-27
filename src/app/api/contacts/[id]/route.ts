import { z } from 'zod'
import type { NextRequest } from 'next/server'
import { prisma } from '@/lib/prisma'
import { getCurrentOrgId } from '@/lib/shell/orgContext'
import { withRoute, json, parseBody, HttpError } from '@/lib/shared/http'

const updateContactSchema = z.object({
  displayName: z.string().min(1).optional(),
  name: z.string().nullable().optional(),
  title: z.string().nullable().optional(),
  timezone: z.string().nullable().optional(),
})

async function requireContact(id: string, organizationId: string) {
  const c = await prisma.contact.findFirst({ where: { id, organizationId }, select: { id: true } })
  if (!c) throw new HttpError(404, 'Contact not found')
}

export const GET = withRoute(async (_req: NextRequest, { correlationId, params }) => {
  const organizationId = await getCurrentOrgId()
  const contact = await prisma.contact.findFirst({
    where: { id: params!.id, organizationId },
    include: { phones: true, emails: true, urls: true },
  })
  if (!contact) throw new HttpError(404, 'Contact not found')
  return json({ contact }, correlationId)
})

export const PUT = withRoute(async (req: NextRequest, { correlationId, params }) => {
  const organizationId = await getCurrentOrgId()
  await requireContact(params!.id, organizationId)
  const body = await parseBody(req, updateContactSchema)
  const contact = await prisma.contact.update({ where: { id: params!.id }, data: body })
  return json({ contact }, correlationId)
})

export const DELETE = withRoute(async (_req: NextRequest, { correlationId, params }) => {
  const organizationId = await getCurrentOrgId()
  await requireContact(params!.id, organizationId)
  await prisma.contact.delete({ where: { id: params!.id } })
  return json({ deleted: true }, correlationId)
})
