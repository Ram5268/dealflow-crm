import { z } from 'zod'
import type { NextRequest } from 'next/server'
import { getCurrentOrgId } from '@/lib/shell/orgContext'
import { withRoute, json, parseBody } from '@/lib/shared/http'
import { checkDestination, parseDestination } from '@/lib/core-data/importer/destination'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

// POST /api/imports/destination — Brief 45 PR F (brief §5.7): the upload's
// "Where should these people go?" step, checked before the file is sent.
// Body { listId } or { newList: { name, folderId } }. The same checks as the
// upload itself (the lists API's name rules and words), writing nothing:
// 200 { ok, name } or the refusal (400 / 404 / 409) with field 'destination'.
const bodySchema = z.strictObject({
  listId: z.string().max(100).optional(),
  newList: z.strictObject({ name: z.string().max(1000), folderId: z.string().max(100).nullable().optional() }).optional(),
})

export const POST = withRoute(async (req: NextRequest, { correlationId }) => {
  const organizationId = await getCurrentOrgId()
  const body = await parseBody(req, bodySchema)
  const destination = parseDestination({ listId: body.listId, newListName: body.newList?.name, newListFolderId: body.newList?.folderId ?? '' })
  const { name } = await checkDestination(organizationId, destination)
  return json({ ok: true, name }, correlationId)
})
