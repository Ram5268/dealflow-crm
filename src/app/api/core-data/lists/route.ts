import { z } from 'zod'
import type { NextRequest } from 'next/server'
import { withRoute, json, parseBody } from '@/lib/shared/http'
import { getCurrentOrgId } from '@/lib/shell/orgContext'
import { createList, listLists } from '@/lib/core-data/lists/lists'

// Brief 45: the active lists (?archived=1: the archived ones), in sidebar
// order; and create a list, in a folder or outside any, optionally with
// people in it already ("Add to list → new list").
export const dynamic = 'force-dynamic'

const bodySchema = z.strictObject({
  name: z.unknown(),
  folderId: z.string().max(100).nullable().optional(),
  leadIds: z.array(z.string().max(100)).optional(),
})

export const GET = withRoute(async (req: NextRequest, { correlationId }) => {
  const organizationId = await getCurrentOrgId()
  const archived = ['1', 'true'].includes(req.nextUrl.searchParams.get('archived') ?? '')
  return json({ lists: await listLists(organizationId, { archived }) }, correlationId)
})

export const POST = withRoute(async (req: NextRequest, { correlationId }) => {
  const organizationId = await getCurrentOrgId()
  const body = await parseBody(req, bodySchema)
  return json(await createList(organizationId, body), correlationId, { status: 201 })
})
