import type { NextRequest } from 'next/server'
import { getCurrentOrgId } from '@/lib/shell/orgContext'
import { withRoute, json, HttpError } from '@/lib/shared/http'
import { getQueue } from '@/lib/core-data/smart-view/queue-service'

// GET /api/queue?viewId=<save_...>&limit=50
// Ranked, pre-scrubbed, callable-now-filtered lead list for Agent B's dialer.
export const dynamic = 'force-dynamic'

export const GET = withRoute(async (req: NextRequest, { correlationId }) => {
  const organizationId = await getCurrentOrgId()
  const viewId = req.nextUrl.searchParams.get('viewId')
  if (!viewId) throw new HttpError(400, 'viewId query param is required')
  const limitParam = req.nextUrl.searchParams.get('limit')
  const limit = limitParam ? Number(limitParam) : 50

  const result = await getQueue(viewId, organizationId, { limit })
  return json(result, correlationId)
})
