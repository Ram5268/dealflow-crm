import { z } from 'zod'
import type { NextRequest } from 'next/server'
import { withRoute, json, parseBody } from '@/lib/shared/http'
import { getCurrentOrgId } from '@/lib/shell/orgContext'
import { createWorkflow, listWorkflows } from '@/lib/core-data/lists/workflows'

// Brief 45: saved Pipeline workflows (SavedView type 'pipeline').
export const dynamic = 'force-dynamic'

const bodySchema = z.strictObject({
  name: z.unknown(), view: z.unknown(), filters: z.unknown().optional(), groupIds: z.unknown().optional(), sort: z.unknown().optional(),
})

export const GET = withRoute(async (_req: NextRequest, { correlationId }) => {
  const organizationId = await getCurrentOrgId()
  return json({ workflows: await listWorkflows(organizationId) }, correlationId)
})

export const POST = withRoute(async (req: NextRequest, { correlationId }) => {
  const organizationId = await getCurrentOrgId()
  const body = await parseBody(req, bodySchema)
  return json({ workflow: await createWorkflow(organizationId, body) }, correlationId, { status: 201 })
})
