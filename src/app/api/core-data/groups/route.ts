import { z } from 'zod'
import type { NextRequest } from 'next/server'
import { withRoute, json, parseBody } from '@/lib/shared/http'
import { getCurrentOrgId } from '@/lib/shell/orgContext'
import { createGroup, listGroups } from '@/lib/core-data/lists/groups'

// Brief 45: every group in sidebar order; create one (with leadId: the
// card's "+" chip, which creates it and adds that lead in one step).
export const dynamic = 'force-dynamic'

const bodySchema = z.strictObject({ name: z.unknown(), color: z.unknown().optional(), leadId: z.string().max(100).optional() })

export const GET = withRoute(async (_req: NextRequest, { correlationId }) => {
  const organizationId = await getCurrentOrgId()
  return json({ groups: await listGroups(organizationId) }, correlationId)
})

export const POST = withRoute(async (req: NextRequest, { correlationId }) => {
  const organizationId = await getCurrentOrgId()
  const body = await parseBody(req, bodySchema)
  return json(await createGroup(organizationId, body), correlationId, { status: 201 })
})
