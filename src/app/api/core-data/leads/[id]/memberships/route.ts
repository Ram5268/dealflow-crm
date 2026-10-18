import type { NextRequest } from 'next/server'
import { withRoute, json } from '@/lib/shared/http'
import { getCurrentOrgId } from '@/lib/shell/orgContext'
import { getLeadMemberships } from '@/lib/core-data/lists/memberships'

// Brief 45: a lead's active lists and groups (the contact card's chips).
export const dynamic = 'force-dynamic'

export const GET = withRoute(async (_req: NextRequest, { correlationId, params }) => {
  const organizationId = await getCurrentOrgId()
  return json(await getLeadMemberships(organizationId, params!.id), correlationId)
})
