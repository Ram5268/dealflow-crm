import { z } from 'zod'
import type { NextRequest } from 'next/server'
import { withRoute, json, parseBody } from '@/lib/shared/http'
import { getCurrentOrgId } from '@/lib/shell/orgContext'
import { deleteGroup, updateGroup } from '@/lib/core-data/lists/groups'

// Brief 45: rename or recolor a group; delete it (its labels go, with a
// timeline entry on each member; the leads stay).
const bodySchema = z.strictObject({ name: z.unknown().optional(), color: z.unknown().optional() })

export const PATCH = withRoute(async (req: NextRequest, { correlationId, params }) => {
  const organizationId = await getCurrentOrgId()
  const body = await parseBody(req, bodySchema)
  return json({ group: await updateGroup(organizationId, params!.id, body) }, correlationId)
})

export const DELETE = withRoute(async (_req: NextRequest, { correlationId, params }) => {
  const organizationId = await getCurrentOrgId()
  return json(await deleteGroup(organizationId, params!.id), correlationId)
})
