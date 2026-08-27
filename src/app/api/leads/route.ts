import { z } from 'zod'
import type { NextRequest } from 'next/server'
import { prisma } from '@/lib/prisma'
import { getCurrentOrgId } from '@/lib/shell/orgContext'
import { withRoute, json, parseBody } from '@/lib/shared/http'

const createLeadSchema = z.object({
  displayName: z.string().min(1),
  name: z.string().optional(),
  description: z.string().optional(),
  source: z.string().optional(),
  statusId: z.string().optional(),
  statusLabel: z.string().optional(),
  url: z.string().optional(),
  primaryAddressFull: z.string().optional(),
  primaryAddressSummary: z.string().optional(),
  timezone: z.string().optional(),
  mojoId: z.string().optional(),
})

const PAGE = 50

export const GET = withRoute(async (req: NextRequest, { correlationId }) => {
  const organizationId = await getCurrentOrgId()
  const url = req.nextUrl
  const take = Math.min(Number(url.searchParams.get('limit')) || PAGE, 200)
  const cursor = url.searchParams.get('cursor') ?? undefined

  const leads = await prisma.lead.findMany({
    where: { organizationId },
    orderBy: [{ updatedAt: 'desc' }, { id: 'desc' }],
    take: take + 1,
    ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
  })
  const hasMore = leads.length > take
  const page = hasMore ? leads.slice(0, take) : leads
  return json(
    { leads: page, nextCursor: hasMore ? page[page.length - 1].id : null },
    correlationId
  )
})

export const POST = withRoute(async (req: NextRequest, { correlationId }) => {
  const organizationId = await getCurrentOrgId()
  const body = await parseBody(req, createLeadSchema)
  const lead = await prisma.lead.create({
    data: { organizationId, ...body },
  })
  return json({ lead }, correlationId, { status: 201 })
})
