import { z } from 'zod'
import type { NextRequest } from 'next/server'
import { prisma } from '@/lib/prisma'
import { getCurrentOrgId } from '@/lib/shell/orgContext'
import { withRoute, json, parseBody, HttpError } from '@/lib/shared/http'

const updateDefSchema = z.object({
  name: z.string().min(1).optional(),
  description: z.string().nullable().optional(),
  choices: z.array(z.string()).optional(),
  displayOrder: z.number().int().optional(),
})

async function requireDef(id: string, organizationId: string) {
  const d = await prisma.customFieldDefinition.findFirst({ where: { id, organizationId }, select: { id: true } })
  if (!d) throw new HttpError(404, 'Custom field definition not found')
}

export const PUT = withRoute(async (req: NextRequest, { correlationId, params }) => {
  const organizationId = await getCurrentOrgId()
  await requireDef(params!.id, organizationId)
  const body = await parseBody(req, updateDefSchema)
  const definition = await prisma.customFieldDefinition.update({ where: { id: params!.id }, data: body })
  return json({ definition }, correlationId)
})

export const DELETE = withRoute(async (_req: NextRequest, { correlationId, params }) => {
  const organizationId = await getCurrentOrgId()
  await requireDef(params!.id, organizationId)
  await prisma.customFieldDefinition.delete({ where: { id: params!.id } })
  return json({ deleted: true }, correlationId)
})
