import type { NextRequest } from 'next/server'
import { prisma } from '@/lib/prisma'
import { getCurrentOrgId } from '@/lib/shell/orgContext'
import { withRoute, json, HttpError } from '@/lib/shared/http'
import { getImportStatus } from '@/lib/core-data/importer/batch'
import { getImportSummary } from '@/lib/core-data/importer/summary'

// Progress for the import page. Brief 41: never returns the raw file or the
// mapping (getImportStatus selects only status, counts and the error log).
// Brief 45 PR F: plus the summary (the list it fills, new and existing
// people, where the new people's ranking stands); never the token hash.
export const GET = withRoute(async (_req: NextRequest, { correlationId, params }) => {
  const organizationId = await getCurrentOrgId()
  const status = await getImportStatus(prisma, params!.id, organizationId)
  if (!status) throw new HttpError(404, 'ImportBatch not found')
  const summary = await getImportSummary(prisma, organizationId, params!.id)
  return json({ ...status, ...summary }, correlationId)
})
