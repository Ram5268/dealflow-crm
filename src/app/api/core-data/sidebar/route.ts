import type { NextRequest } from 'next/server'
import { withRoute, json } from '@/lib/shared/http'
import { getCurrentOrgId } from '@/lib/shell/orgContext'
import { getSidebar } from '@/lib/core-data/lists/sidebar'

// Brief 45: the Mojo-style sidebar in one round trip — All leads, folders,
// lists, the archived count, groups and saved Pipeline workflows.
export const dynamic = 'force-dynamic'

export const GET = withRoute(async (_req: NextRequest, { correlationId }) => {
  const organizationId = await getCurrentOrgId()
  return json(await getSidebar(organizationId), correlationId)
})
