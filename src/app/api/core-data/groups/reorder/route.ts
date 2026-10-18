import { z } from 'zod'
import type { NextRequest } from 'next/server'
import { withRoute, json, parseBody } from '@/lib/shared/http'
import { getCurrentOrgId } from '@/lib/shell/orgContext'
import { reorderGroups } from '@/lib/core-data/lists/groups'

// Brief 45: every group of the org, in the new order (the order of the chips).
const bodySchema = z.strictObject({ ids: z.array(z.string().max(100)) })

export const POST = withRoute(async (req: NextRequest, { correlationId }) => {
  const organizationId = await getCurrentOrgId()
  const { ids } = await parseBody(req, bodySchema)
  return json(await reorderGroups(organizationId, ids), correlationId)
})
