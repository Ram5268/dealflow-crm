import { z } from 'zod'
import type { NextRequest } from 'next/server'
import { withRoute, json } from '@/lib/shared/http'
import { getCurrentOrgId } from '@/lib/shell/orgContext'
import { createFolder } from '@/lib/core-data/lists/folders'
import { parseFolderBody } from '@/lib/core-data/lists/route-helpers'

// Brief 45: create a folder. A folder holds lists only, so the body is a name
// and nothing else [Ryan, 2026-10-18].
const bodySchema = z.strictObject({ name: z.unknown() })

export const POST = withRoute(async (req: NextRequest, { correlationId }) => {
  const organizationId = await getCurrentOrgId()
  const body = await parseFolderBody(req, bodySchema)
  return json({ folder: await createFolder(organizationId, body) }, correlationId, { status: 201 })
})
