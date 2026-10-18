import { z } from 'zod'
import type { NextRequest } from 'next/server'
import { withRoute, json, parseBody } from '@/lib/shared/http'
import { getCurrentOrgId } from '@/lib/shell/orgContext'
import { addGroupMembers, removeGroupMembers } from '@/lib/core-data/lists/groups'

// Brief 45: bulk "Add to group" / "Remove from group". List membership is
// never touched [Ryan, 2026-10-18].
const bodySchema = z.strictObject({ leadIds: z.array(z.string().max(100)) })

export const POST = withRoute(async (req: NextRequest, { correlationId, params }) => {
  const organizationId = await getCurrentOrgId()
  const { leadIds } = await parseBody(req, bodySchema)
  return json(await addGroupMembers(organizationId, params!.id, leadIds), correlationId)
})

export const DELETE = withRoute(async (req: NextRequest, { correlationId, params }) => {
  const organizationId = await getCurrentOrgId()
  const { leadIds } = await parseBody(req, bodySchema)
  return json(await removeGroupMembers(organizationId, params!.id, leadIds), correlationId)
})
