import { z } from 'zod'
import type { NextRequest } from 'next/server'
import { prisma } from '@/lib/prisma'
import { getCurrentOrgId } from '@/lib/shell/orgContext'
import { withRoute, json, parseBody, HttpError } from '@/lib/shared/http'

const createOppSchema = z.object({
  leadId: z.string().min(1),
  contactId: z.string().optional(),
  pipelineId: z.string().optional(),
  statusId: z.string().optional(),
  statusLabel: z.string().optional(),
  statusType: z.string().default('active'),
  confidence: z.number().int().min(0).max(100).default(0),
  value: z.number().int().nullable().optional(),
  valuePeriod: z.string().default('one_time'),
  valueCurrency: z.string().default('USD'),
  note: z.string().optional(),
})

export const GET = withRoute(async (req: NextRequest, { correlationId }) => {
  const organizationId = await getCurrentOrgId()
  const leadId = req.nextUrl.searchParams.get('leadId') ?? undefined
  const opportunities = await prisma.opportunity.findMany({
    where: { organizationId, ...(leadId ? { leadId } : {}) },
    orderBy: [{ updatedAt: 'desc' }, { id: 'desc' }],
    take: Math.min(Number(req.nextUrl.searchParams.get('limit')) || 50, 200),
  })
  return json({ opportunities }, correlationId)
})

export const POST = withRoute(async (req: NextRequest, { correlationId }) => {
  const organizationId = await getCurrentOrgId()
  const body = await parseBody(req, createOppSchema)
  const lead = await prisma.lead.findFirst({ where: { id: body.leadId, organizationId }, select: { id: true } })
  if (!lead) throw new HttpError(400, 'leadId does not reference an org lead')
  const opportunity = await prisma.opportunity.create({ data: { organizationId, ...body } })
  return json({ opportunity }, correlationId, { status: 201 })
})
