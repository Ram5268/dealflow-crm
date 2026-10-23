import type { NextRequest } from 'next/server'
import { withRoute, json } from '@/lib/shared/http'
import { getCurrentOrgId } from '@/lib/shell/orgContext'
import { getPipeline, getPipelineIds, parsePipelineQuery } from '@/lib/core-data/lists/pipeline'

// Brief 45: the Pipeline page's data, as a board (one column per group) or a
// table (one row per lead). The query string is CONTRACT §6b. Brief 50 PR 7:
// with ids=1, { ids } instead: everyone the table shows for those groups,
// filters and sort (every page, at most 25,000), for its "Select all N
// matching", like the list pages' and All leads' ids=1.
export const dynamic = 'force-dynamic'

export const GET = withRoute(async (req: NextRequest, { correlationId }) => {
  const organizationId = await getCurrentOrgId()
  const sp = req.nextUrl.searchParams
  const query = parsePipelineQuery(sp)
  if (sp.get('ids') === '1') return json({ ids: await getPipelineIds(organizationId, query) }, correlationId)
  return json(await getPipeline(organizationId, query), correlationId)
})
