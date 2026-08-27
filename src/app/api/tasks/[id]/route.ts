import { z } from 'zod'
import type { NextRequest } from 'next/server'
import { prisma } from '@/lib/prisma'
import { getCurrentOrgId } from '@/lib/shell/orgContext'
import { withRoute, json, parseBody, HttpError } from '@/lib/shared/http'

const updateTaskSchema = z.object({
  text: z.string().min(1).optional(),
  type: z.string().optional(),
  dueDate: z.string().datetime().nullable().optional(),
  isDateless: z.boolean().optional(),
  isComplete: z.boolean().optional(),
})

async function requireTask(id: string, organizationId: string) {
  const t = await prisma.task.findFirst({ where: { id, organizationId }, select: { id: true } })
  if (!t) throw new HttpError(404, 'Task not found')
}

export const GET = withRoute(async (_req: NextRequest, { correlationId, params }) => {
  const organizationId = await getCurrentOrgId()
  const task = await prisma.task.findFirst({ where: { id: params!.id, organizationId } })
  if (!task) throw new HttpError(404, 'Task not found')
  return json({ task }, correlationId)
})

export const PUT = withRoute(async (req: NextRequest, { correlationId, params }) => {
  const organizationId = await getCurrentOrgId()
  await requireTask(params!.id, organizationId)
  const body = await parseBody(req, updateTaskSchema)
  const task = await prisma.task.update({
    where: { id: params!.id },
    data: {
      ...body,
      dueDate: body.dueDate ? new Date(body.dueDate) : body.dueDate,
      ...(body.isComplete !== undefined
        ? { isComplete: body.isComplete, completedAt: body.isComplete ? new Date() : null }
        : {}),
    },
  })
  return json({ task }, correlationId)
})

export const DELETE = withRoute(async (_req: NextRequest, { correlationId, params }) => {
  const organizationId = await getCurrentOrgId()
  await requireTask(params!.id, organizationId)
  await prisma.task.delete({ where: { id: params!.id } })
  return json({ deleted: true }, correlationId)
})
