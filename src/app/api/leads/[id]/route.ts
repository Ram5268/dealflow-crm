import { z } from 'zod'
import type { NextRequest } from 'next/server'
import { prisma } from '@/lib/prisma'
import { getCurrentOrgId } from '@/lib/shell/orgContext'
import { withRoute, json, parseBody, HttpError } from '@/lib/shared/http'
import { hydrateCustomFields } from '@/lib/core-data/leads/serialize'

const updateLeadSchema = z.object({
  displayName: z.string().min(1).optional(),
  name: z.string().nullable().optional(),
  description: z.string().nullable().optional(),
  statusId: z.string().nullable().optional(),
  statusLabel: z.string().nullable().optional(),
  url: z.string().nullable().optional(),
  primaryAddressFull: z.string().nullable().optional(),
  primaryAddressSummary: z.string().nullable().optional(),
  timezone: z.string().nullable().optional(),
})

export const GET = withRoute(async (_req: NextRequest, { correlationId, params }) => {
  const organizationId = await getCurrentOrgId()
  const id = params!.id
  const lead = await prisma.lead.findFirst({
    where: { id, organizationId },
    include: {
      contacts: { include: { phones: true, emails: true, urls: true } },
      opportunities: true,
      tasks: true,
    },
  })
  if (!lead) throw new HttpError(404, 'Lead not found')
  const customFields = await hydrateCustomFields(id)
  return json({ ...lead, customFields }, correlationId)
})

export const PUT = withRoute(async (req: NextRequest, { correlationId, params }) => {
  const organizationId = await getCurrentOrgId()
  const id = params!.id
  const body = await parseBody(req, updateLeadSchema)
  const existing = await prisma.lead.findFirst({ where: { id, organizationId }, select: { id: true } })
  if (!existing) throw new HttpError(404, 'Lead not found')
  const lead = await prisma.lead.update({ where: { id }, data: body })
  return json({ lead }, correlationId)
})

export const DELETE = withRoute(async (_req: NextRequest, { correlationId, params }) => {
  const organizationId = await getCurrentOrgId()
  const id = params!.id
  const existing = await prisma.lead.findFirst({ where: { id, organizationId }, select: { id: true } })
  if (!existing) throw new HttpError(404, 'Lead not found')
  await prisma.lead.delete({ where: { id } })
  return json({ deleted: true }, correlationId)
})
