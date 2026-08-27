import type { NextRequest } from 'next/server'
import { prisma } from '@/lib/prisma'
import { getCurrentOrgId } from '@/lib/shell/orgContext'
import { withRoute, json } from '@/lib/shared/http'

// Activity timeline for a single lead, paginated newest-first.
export const GET = withRoute(async (req: NextRequest, { correlationId, params }) => {
  const organizationId = await getCurrentOrgId()
  const leadId = params!.id
  const take = Math.min(Number(req.nextUrl.searchParams.get('limit')) || 50, 200)
  const cursor = req.nextUrl.searchParams.get('cursor') ?? undefined
  const activities = await prisma.activity.findMany({
    where: { organizationId, leadId },
    orderBy: [{ activityAt: 'desc' }, { id: 'desc' }],
    take: take + 1,
    ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
  })
  const hasMore = activities.length > take
  const page = hasMore ? activities.slice(0, take) : activities
  return json(
    { activities: page, nextCursor: hasMore ? page[page.length - 1].id : null },
    correlationId
  )
})
