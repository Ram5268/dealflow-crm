import { z } from 'zod'
import type { NextRequest } from 'next/server'
import { withRoute, json, parseBody } from '@/lib/shared/http'
import { getCurrentOrgId } from '@/lib/shell/orgContext'
import { deleteList, updateList } from '@/lib/core-data/lists/lists'

// Brief 45: rename, move (into a folder, or out: folderId null; it goes last
// there), archive or unarchive a list; or delete it. Neither ever deletes a
// lead [brief §5.1].
const bodySchema = z.strictObject({
  name: z.unknown().optional(),
  folderId: z.string().max(100).nullable().optional(),
  archived: z.boolean().optional(),
})

export const PATCH = withRoute(async (req: NextRequest, { correlationId, params }) => {
  const organizationId = await getCurrentOrgId()
  const body = await parseBody(req, bodySchema)
  return json({ list: await updateList(organizationId, params!.id, body) }, correlationId)
})

export const DELETE = withRoute(async (_req: NextRequest, { correlationId, params }) => {
  const organizationId = await getCurrentOrgId()
  return json(await deleteList(organizationId, params!.id), correlationId)
})
