import { z } from 'zod'
import type { NextRequest } from 'next/server'
import { prisma } from '@/lib/prisma'
import { getCurrentOrgId } from '@/lib/shell/orgContext'
import { withRoute, json, parseBody, HttpError } from '@/lib/shared/http'
import { sQuerySchema, sortSpecSchema } from '@/lib/core-data/query-dsl/schema'
import { WORKFLOW_VIEW_TYPE } from '@/lib/core-data/lists/types'

// Brief 45: a saved Pipeline workflow is also a SavedView (type 'pipeline'),
// but it is not a lead Smart View, so this API never lists, reads or creates
// one; /api/core-data/workflows owns them.

const createViewSchema = z.object({
  name: z.string().min(1),
  description: z.string().optional(),
  type: z.string().default('lead'),
  sQuery: sQuerySchema,
  selectedFields: z.array(z.string()).default([]),
  sort: sortSpecSchema.default([]),
  resultsLimit: z.number().int().positive().optional(),
})

export const GET = withRoute(async (req: NextRequest, { correlationId }) => {
  const organizationId = await getCurrentOrgId()
  const type = req.nextUrl.searchParams.get('type') ?? undefined
  const views = await prisma.savedView.findMany({
    where: { organizationId, AND: [{ type: { not: WORKFLOW_VIEW_TYPE } }, ...(type ? [{ type }] : [])] },
    orderBy: [{ updatedAt: 'desc' }],
  })
  return json({ views }, correlationId)
})

export const POST = withRoute(async (req: NextRequest, { correlationId }) => {
  const organizationId = await getCurrentOrgId()
  const body = await parseBody(req, createViewSchema)
  if (body.type === WORKFLOW_VIEW_TYPE) {
    throw new HttpError(400, 'Pipeline workflows are saved from the Pipeline page, not as Smart Views.')
  }
  const view = await prisma.savedView.create({
    data: {
      organizationId,
      name: body.name,
      description: body.description,
      type: body.type,
      sQuery: body.sQuery,
      selectedFields: body.selectedFields,
      sort: body.sort,
      resultsLimit: body.resultsLimit,
    },
  })
  return json({ view }, correlationId, { status: 201 })
})
