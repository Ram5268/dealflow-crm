import { z } from 'zod'
import type { NextRequest } from 'next/server'
import { withRoute, json, parseBody } from '@/lib/shared/http'
import { getCurrentOrgId } from '@/lib/shell/orgContext'
import { reorderFolders } from '@/lib/core-data/lists/folders'

// Brief 45: every folder of the org, in the new order.
const bodySchema = z.strictObject({ ids: z.array(z.string().max(100)) })

export const POST = withRoute(async (req: NextRequest, { correlationId }) => {
  const organizationId = await getCurrentOrgId()
  const { ids } = await parseBody(req, bodySchema)
  return json(await reorderFolders(organizationId, ids), correlationId)
})
