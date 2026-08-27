import { z } from 'zod'
import type { NextRequest } from 'next/server'
import { prisma } from '@/lib/prisma'
import { getCurrentOrgId } from '@/lib/shell/orgContext'
import { withRoute, json, parseBody, HttpError } from '@/lib/shared/http'

export const CUSTOM_FIELD_TYPES = ['text', 'number', 'date', 'datetime', 'url', 'email', 'choices'] as const

const createDefSchema = z.object({
  objectType: z.string().default('lead'),
  name: z.string().min(1),
  description: z.string().optional(),
  type: z.enum(CUSTOM_FIELD_TYPES),
  choices: z.array(z.string()).default([]),
  acceptsMultipleValues: z.boolean().default(false),
  displayOrder: z.number().int().optional(),
})

export const GET = withRoute(async (req: NextRequest, { correlationId }) => {
  const organizationId = await getCurrentOrgId()
  const objectType = req.nextUrl.searchParams.get('objectType') ?? undefined
  const definitions = await prisma.customFieldDefinition.findMany({
    where: { organizationId, ...(objectType ? { objectType } : {}) },
    orderBy: [{ objectType: 'asc' }, { displayOrder: 'asc' }],
  })
  return json({ definitions }, correlationId)
})

export const POST = withRoute(async (req: NextRequest, { correlationId }) => {
  const organizationId = await getCurrentOrgId()
  const body = await parseBody(req, createDefSchema)
  // Default displayOrder to end of list for this objectType.
  let displayOrder = body.displayOrder
  if (displayOrder === undefined) {
    const max = await prisma.customFieldDefinition.aggregate({
      where: { organizationId, objectType: body.objectType },
      _max: { displayOrder: true },
    })
    displayOrder = (max._max.displayOrder ?? -1) + 1
  }
  try {
    const definition = await prisma.customFieldDefinition.create({
      data: { organizationId, ...body, displayOrder },
    })
    return json({ definition }, correlationId, { status: 201 })
  } catch (err) {
    if (err && typeof err === 'object' && 'code' in err && (err as { code: string }).code === 'P2002') {
      throw new HttpError(409, `Custom field "${body.name}" already exists for ${body.objectType}`)
    }
    throw err
  }
})
