import type { NextRequest } from 'next/server'
import { withRoute, json } from '@/lib/shared/http'
import { getCurrentOrgId } from '@/lib/shell/orgContext'
import { getRankedIds, getRankedPage } from '@/lib/core-data/lists/ranked'
import { parseMemberQuery } from '@/lib/core-data/lists/route-helpers'

// Brief 45: All leads (every homeowner in the CRM, built in, never
// deletable) in the same ranked order as every list.
export const dynamic = 'force-dynamic'

export const GET = withRoute(async (req: NextRequest, { correlationId }) => {
  const organizationId = await getCurrentOrgId()
  const { page, filters, ids } = parseMemberQuery(req.nextUrl.searchParams)
  if (ids) return json({ ids: await getRankedIds(organizationId, null, { filters }) }, correlationId)
  return json(await getRankedPage(organizationId, null, { page, filters }), correlationId)
})
