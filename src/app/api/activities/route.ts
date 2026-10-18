import type { NextRequest } from 'next/server'
import { prisma } from '@/lib/prisma'
import { getCurrentOrgId } from '@/lib/shell/orgContext'
import { withRoute, json, errorResponse } from '@/lib/shared/http'

// Activities are append-only, written by event consumers (call / message
// handlers) and, since Brief 45, by group changes (type 'Group' timeline
// entries, src/lib/core-data/lists/timeline.ts). Nobody creates, updates or
// deletes them through this route — POST returns 405.

export const GET = withRoute(async (req: NextRequest, { correlationId }) => {
  const organizationId = await getCurrentOrgId()
  const url = req.nextUrl
  const leadId = url.searchParams.get('leadId') ?? undefined
  const contactId = url.searchParams.get('contactId') ?? undefined
  const take = Math.min(Number(url.searchParams.get('limit')) || 50, 200)
  const cursor = url.searchParams.get('cursor') ?? undefined

  const activities = await prisma.activity.findMany({
    where: { organizationId, ...(leadId ? { leadId } : {}), ...(contactId ? { contactId } : {}) },
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

export const POST = withRoute(async (_req: NextRequest, { correlationId }) => {
  return errorResponse(
    'Activities are append-only from event consumers; direct creation is not allowed',
    405,
    correlationId
  )
})
