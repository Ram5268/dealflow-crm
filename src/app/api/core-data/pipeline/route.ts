import type { NextRequest } from 'next/server'
import { withRoute, json } from '@/lib/shared/http'
import { getCurrentOrgId } from '@/lib/shell/orgContext'
import { getPipeline, parsePipelineQuery } from '@/lib/core-data/lists/pipeline'

// Brief 45: the Pipeline page's data, as a board (one column per group) or a
// table (one row per lead). The query string is CONTRACT §6b.
export const dynamic = 'force-dynamic'

export const GET = withRoute(async (req: NextRequest, { correlationId }) => {
  const organizationId = await getCurrentOrgId()
  return json(await getPipeline(organizationId, parsePipelineQuery(req.nextUrl.searchParams)), correlationId)
})
