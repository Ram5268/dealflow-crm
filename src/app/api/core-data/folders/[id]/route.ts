import { z } from 'zod'
import type { NextRequest } from 'next/server'
import { withRoute, json } from '@/lib/shared/http'
import { getCurrentOrgId } from '@/lib/shell/orgContext'
import { deleteFolder, renameFolder } from '@/lib/core-data/lists/folders'
import { parseFolderBody } from '@/lib/core-data/lists/route-helpers'

// Brief 45: rename a folder (no other field: folders can't nest), or delete
// it when it has no lists left, archived ones included.
const bodySchema = z.strictObject({ name: z.unknown() })

export const PATCH = withRoute(async (req: NextRequest, { correlationId, params }) => {
  const organizationId = await getCurrentOrgId()
  const body = await parseFolderBody(req, bodySchema)
  return json({ folder: await renameFolder(organizationId, params!.id, body) }, correlationId)
})

export const DELETE = withRoute(async (_req: NextRequest, { correlationId, params }) => {
  const organizationId = await getCurrentOrgId()
  return json(await deleteFolder(organizationId, params!.id), correlationId)
})
