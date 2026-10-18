import { z } from 'zod'
import type { NextRequest } from 'next/server'
import { withRoute, json, parseBody } from '@/lib/shared/http'
import { getCurrentOrgId } from '@/lib/shell/orgContext'
import { reorderLists } from '@/lib/core-data/lists/lists'

// Brief 45: the active lists of one folder (or of "outside folders":
// folderId null), in the new order.
const bodySchema = z.strictObject({ folderId: z.string().max(100).nullable(), ids: z.array(z.string().max(100)) })

export const POST = withRoute(async (req: NextRequest, { correlationId }) => {
  const organizationId = await getCurrentOrgId()
  const body = await parseBody(req, bodySchema)
  return json(await reorderLists(organizationId, body), correlationId)
})
