import type { NextRequest } from 'next/server'
import { withRoute } from '@/lib/shared/http'
import { getCurrentOrgId } from '@/lib/shell/orgContext'
import { exportRankedCsv } from '@/lib/core-data/lists/ranked'
import { csvResponse, parseMemberQuery } from '@/lib/core-data/lists/route-helpers'

// Brief 45: All leads as CSV in rank order. No phone numbers or emails
// [engineering precaution].
export const dynamic = 'force-dynamic'

export const GET = withRoute(async (req: NextRequest, { correlationId }) => {
  const organizationId = await getCurrentOrgId()
  const { filters } = parseMemberQuery(req.nextUrl.searchParams)
  return csvResponse(await exportRankedCsv(organizationId, null, { filters }), correlationId)
})
