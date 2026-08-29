import { NextResponse } from 'next/server'
import { getCurrentOrgId } from '@/lib/shell/orgContext'
import { prisma } from '@/lib/prisma'

export const dynamic = 'force-dynamic'

/**
 * Unread badge count for the shell sidebar (§7).
 *
 * DEVIATION from the planner's sketch (`{ readAt: null, archivedAt: null }`):
 * also filters `direction: 'incoming'`. Outbound mail is never "unread" by the
 * sender, and without this filter every message Ryan sends would inflate the
 * badge — which would make it useless within a day of dialing.
 *
 * A static segment beats a dynamic one in the App Router, so this does not
 * collide with ./[id].
 */
export async function GET() {
  const organizationId = await getCurrentOrgId()
  const count = await prisma.message.count({
    where: { organizationId, direction: 'incoming', readAt: null, archivedAt: null },
  })
  return NextResponse.json({ count })
}
