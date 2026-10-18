import { z } from 'zod'
import type { NextRequest } from 'next/server'
import { withRoute, json, parseBody } from '@/lib/shared/http'
import { getCurrentOrgId } from '@/lib/shell/orgContext'
import { moveLeadBetweenGroups } from '@/lib/core-data/lists/groups'

// Brief 45: a Pipeline drag from one column to another: out of one group,
// into the other, in one transaction with both timeline entries.
const bodySchema = z.strictObject({ leadId: z.string().max(100), fromGroupId: z.string().max(100), toGroupId: z.string().max(100) })

export const POST = withRoute(async (req: NextRequest, { correlationId }) => {
  const organizationId = await getCurrentOrgId()
  const body = await parseBody(req, bodySchema)
  return json(await moveLeadBetweenGroups(organizationId, body), correlationId)
})
