import { z } from 'zod'
import type { NextRequest } from 'next/server'
import { prisma } from '@/lib/prisma'
import { getCurrentOrgId } from '@/lib/shell/orgContext'
import { withRoute, json, parseBody, HttpError } from '@/lib/shared/http'

const updateOppSchema = z.object({
  statusId: z.string().nullable().optional(),
  statusLabel: z.string().nullable().optional(),
  statusType: z.string().optional(),
  confidence: z.number().int().min(0).max(100).optional(),
  value: z.number().int().nullable().optional(),
  note: z.string().nullable().optional(),
  dateWon: z.string().datetime().nullable().optional(),
  dateLost: z.string().datetime().nullable().optional(),
})

async function requireOpp(id: string, organizationId: string) {
  const o = await prisma.opportunity.findFirst({ where: { id, organizationId }, select: { id: true } })
  if (!o) throw new HttpError(404, 'Opportunity not found')
}

export const GET = withRoute(async (_req: NextRequest, { correlationId, params }) => {
  const organizationId = await getCurrentOrgId()
  const opportunity = await prisma.opportunity.findFirst({ where: { id: params!.id, organizationId } })
  if (!opportunity) throw new HttpError(404, 'Opportunity not found')
  return json({ opportunity }, correlationId)
})

export const PUT = withRoute(async (req: NextRequest, { correlationId, params }) => {
  const organizationId = await getCurrentOrgId()
  await requireOpp(params!.id, organizationId)
  const body = await parseBody(req, updateOppSchema)
  const opportunity = await prisma.opportunity.update({
    where: { id: params!.id },
    data: {
      ...body,
      dateWon: body.dateWon ? new Date(body.dateWon) : body.dateWon,
      dateLost: body.dateLost ? new Date(body.dateLost) : body.dateLost,
    },
  })
  return json({ opportunity }, correlationId)
})

export const DELETE = withRoute(async (_req: NextRequest, { correlationId, params }) => {
  const organizationId = await getCurrentOrgId()
  await requireOpp(params!.id, organizationId)
  await prisma.opportunity.delete({ where: { id: params!.id } })
  return json({ deleted: true }, correlationId)
})
