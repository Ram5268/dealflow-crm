import { z } from 'zod'
import type { NextRequest } from 'next/server'
import { prisma } from '@/lib/prisma'
import { getCurrentOrgId } from '@/lib/shell/orgContext'
import { withRoute, json, parseBody } from '@/lib/shared/http'

const createTaskSchema = z.object({
  leadId: z.string().optional(),
  contactId: z.string().optional(),
  type: z.string().default('todo'),
  text: z.string().min(1),
  dueDate: z.string().datetime().nullable().optional(),
  isDateless: z.boolean().default(false),
  assignedToId: z.string().optional(),
})

export const GET = withRoute(async (req: NextRequest, { correlationId }) => {
  const organizationId = await getCurrentOrgId()
  const leadId = req.nextUrl.searchParams.get('leadId') ?? undefined
  const includeComplete = req.nextUrl.searchParams.get('includeComplete') === 'true'
  const tasks = await prisma.task.findMany({
    where: { organizationId, ...(leadId ? { leadId } : {}), ...(includeComplete ? {} : { isComplete: false }) },
    orderBy: [{ dueDate: 'asc' }, { createdAt: 'desc' }],
    take: Math.min(Number(req.nextUrl.searchParams.get('limit')) || 50, 200),
  })
  return json({ tasks }, correlationId)
})

export const POST = withRoute(async (req: NextRequest, { correlationId }) => {
  const organizationId = await getCurrentOrgId()
  const body = await parseBody(req, createTaskSchema)
  const task = await prisma.task.create({
    data: {
      organizationId,
      leadId: body.leadId,
      contactId: body.contactId,
      type: body.type,
      text: body.text,
      dueDate: body.dueDate ? new Date(body.dueDate) : null,
      isDateless: body.isDateless,
      assignedToId: body.assignedToId,
    },
  })
  return json({ task }, correlationId, { status: 201 })
})
