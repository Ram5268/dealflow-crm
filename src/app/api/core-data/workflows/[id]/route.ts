import { z } from 'zod'
import type { NextRequest } from 'next/server'
import { withRoute, json, parseBody } from '@/lib/shared/http'
import { getCurrentOrgId } from '@/lib/shell/orgContext'
import { deleteWorkflow, updateWorkflow } from '@/lib/core-data/lists/workflows'

// Brief 45: rename or change a saved Pipeline workflow, or delete it.
const bodySchema = z.strictObject({
  name: z.unknown().optional(), view: z.unknown().optional(), filters: z.unknown().optional(),
  groupIds: z.unknown().optional(), sort: z.unknown().optional(),
})

export const PATCH = withRoute(async (req: NextRequest, { correlationId, params }) => {
  const organizationId = await getCurrentOrgId()
  const body = await parseBody(req, bodySchema)
  return json({ workflow: await updateWorkflow(organizationId, params!.id, body) }, correlationId)
})

export const DELETE = withRoute(async (_req: NextRequest, { correlationId, params }) => {
  const organizationId = await getCurrentOrgId()
  return json(await deleteWorkflow(organizationId, params!.id), correlationId)
})
