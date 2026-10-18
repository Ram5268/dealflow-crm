import { z } from 'zod'
import type { NextRequest } from 'next/server'
import { withRoute, json, parseBody } from '@/lib/shared/http'
import { getCurrentOrgId } from '@/lib/shell/orgContext'
import { getRankedIds, getRankedPage } from '@/lib/core-data/lists/ranked'
import { addListMembers, removeListMembers } from '@/lib/core-data/lists/memberships'
import { parseMemberQuery } from '@/lib/core-data/lists/route-helpers'

// Brief 45: a list's people, always in ranked order, 100 per page, rank
// numbers global (?ids=1: every matching id, for "select all"); add people
// (they stay on their other lists) or take them off this list's call order.
// Display-only reads: no phone numbers or emails.
export const dynamic = 'force-dynamic'

const bodySchema = z.strictObject({ leadIds: z.array(z.string().max(100)) })

export const GET = withRoute(async (req: NextRequest, { correlationId, params }) => {
  const organizationId = await getCurrentOrgId()
  const { page, filters, ids } = parseMemberQuery(req.nextUrl.searchParams)
  if (ids) return json({ ids: await getRankedIds(organizationId, params!.id, { filters }) }, correlationId)
  return json(await getRankedPage(organizationId, params!.id, { page, filters }), correlationId)
})

export const POST = withRoute(async (req: NextRequest, { correlationId, params }) => {
  const organizationId = await getCurrentOrgId()
  const { leadIds } = await parseBody(req, bodySchema)
  return json(await addListMembers(organizationId, params!.id, leadIds), correlationId)
})

export const DELETE = withRoute(async (req: NextRequest, { correlationId, params }) => {
  const organizationId = await getCurrentOrgId()
  const { leadIds } = await parseBody(req, bodySchema)
  return json(await removeListMembers(organizationId, params!.id, leadIds), correlationId)
})
