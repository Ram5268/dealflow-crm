import type { NextRequest } from 'next/server'
import { withRoute, json } from '@/lib/shared/http'
import { getCurrentOrgId } from '@/lib/shell/orgContext'
import { addLeadToGroup, removeLeadFromGroup } from '@/lib/core-data/lists/groups'

// Brief 45: one click on a group chip. PUT adds, DELETE removes; both are
// idempotent ({ changed: false } when nothing changed, and no timeline entry).
export const PUT = withRoute(async (_req: NextRequest, { correlationId, params }) => {
  const organizationId = await getCurrentOrgId()
  return json(await addLeadToGroup(organizationId, params!.id, params!.leadId), correlationId)
})

export const DELETE = withRoute(async (_req: NextRequest, { correlationId, params }) => {
  const organizationId = await getCurrentOrgId()
  return json(await removeLeadFromGroup(organizationId, params!.id, params!.leadId), correlationId)
})
