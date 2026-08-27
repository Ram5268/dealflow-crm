import { z } from 'zod'
import type { NextRequest } from 'next/server'
import { prisma } from '@/lib/prisma'
import { getCurrentOrgId } from '@/lib/shell/orgContext'
import { withRoute, json, parseBody, HttpError } from '@/lib/shared/http'
import { sQuerySchema, sortSpecSchema } from '@/lib/core-data/query-dsl/schema'

const updateViewSchema = z.object({
  name: z.string().min(1).optional(),
  description: z.string().nullable().optional(),
  sQuery: sQuerySchema.optional(),
  selectedFields: z.array(z.string()).optional(),
  sort: sortSpecSchema.optional(),
  resultsLimit: z.number().int().positive().nullable().optional(),
})

async function requireView(id: string, organizationId: string) {
  const v = await prisma.savedView.findFirst({ where: { id, organizationId }, select: { id: true } })
  if (!v) throw new HttpError(404, 'SavedView not found')
}

export const GET = withRoute(async (_req: NextRequest, { correlationId, params }) => {
  const organizationId = await getCurrentOrgId()
  const view = await prisma.savedView.findFirst({ where: { id: params!.id, organizationId } })
  if (!view) throw new HttpError(404, 'SavedView not found')
  return json({ view }, correlationId)
})

export const PUT = withRoute(async (req: NextRequest, { correlationId, params }) => {
  const organizationId = await getCurrentOrgId()
  await requireView(params!.id, organizationId)
  const body = await parseBody(req, updateViewSchema)
  const view = await prisma.savedView.update({
    where: { id: params!.id },
    data: {
      ...(body.name !== undefined ? { name: body.name } : {}),
      ...(body.description !== undefined ? { description: body.description } : {}),
      ...(body.sQuery !== undefined ? { sQuery: body.sQuery } : {}),
      ...(body.selectedFields !== undefined ? { selectedFields: body.selectedFields } : {}),
      ...(body.sort !== undefined ? { sort: body.sort } : {}),
      ...(body.resultsLimit !== undefined ? { resultsLimit: body.resultsLimit } : {}),
    },
  })
  return json({ view }, correlationId)
})

export const DELETE = withRoute(async (_req: NextRequest, { correlationId, params }) => {
  const organizationId = await getCurrentOrgId()
  await requireView(params!.id, organizationId)
  await prisma.savedView.delete({ where: { id: params!.id } })
  return json({ deleted: true }, correlationId)
})
