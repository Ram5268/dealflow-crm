import { z } from 'zod'
import type { NextRequest } from 'next/server'
import { prisma } from '@/lib/prisma'
import { getCurrentOrgId } from '@/lib/shell/orgContext'
import { withRoute, json, parseBody, HttpError } from '@/lib/shared/http'
import { hydrateCustomFields } from '@/lib/core-data/leads/serialize'
import { buildCustomValueColumns } from '@/lib/core-data/leads/custom-values'

const putSchema = z.object({
  values: z.array(
    z.object({
      definitionId: z.string().min(1),
      value: z.unknown(),
    })
  ),
})

export const GET = withRoute(async (_req: NextRequest, { correlationId, params }) => {
  const organizationId = await getCurrentOrgId()
  const lead = await prisma.lead.findFirst({ where: { id: params!.id, organizationId }, select: { id: true } })
  if (!lead) throw new HttpError(404, 'Lead not found')
  const customFields = await hydrateCustomFields(params!.id)
  return json({ customFields }, correlationId)
})

export const PUT = withRoute(async (req: NextRequest, { correlationId, params }) => {
  const organizationId = await getCurrentOrgId()
  const leadId = params!.id
  const lead = await prisma.lead.findFirst({ where: { id: leadId, organizationId }, select: { id: true } })
  if (!lead) throw new HttpError(404, 'Lead not found')
  const body = await parseBody(req, putSchema)

  const defIds = body.values.map((v) => v.definitionId)
  const defs = await prisma.customFieldDefinition.findMany({
    where: { organizationId, id: { in: defIds }, objectType: 'lead' },
  })
  const defById = new Map(defs.map((d) => [d.id, d]))

  for (const { definitionId, value } of body.values) {
    const def = defById.get(definitionId)
    if (!def) throw new HttpError(400, `Unknown custom field definition ${definitionId}`)
    const cols = buildCustomValueColumns(def.type, value)
    await prisma.customFieldValue.upsert({
      where: { definitionId_objectId: { definitionId, objectId: leadId } },
      create: { organizationId, definitionId, objectType: 'lead', objectId: leadId, ...cols },
      update: cols,
    })
  }

  const customFields = await hydrateCustomFields(leadId)
  return json({ customFields }, correlationId)
})
