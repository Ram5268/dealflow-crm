import type { NextRequest } from 'next/server'
import { prisma } from '@/lib/prisma'
import { getCurrentOrgId } from '@/lib/shell/orgContext'
import { withRoute, json, HttpError } from '@/lib/shared/http'

export const GET = withRoute(async (_req: NextRequest, { correlationId, params }) => {
  const organizationId = await getCurrentOrgId()
  const batch = await prisma.importBatch.findFirst({ where: { id: params!.id, organizationId } })
  if (!batch) throw new HttpError(404, 'ImportBatch not found')
  const progress =
    batch.totalRows > 0
      ? Math.round(((batch.importedRows + batch.skippedRows + batch.errorRows) / batch.totalRows) * 100)
      : batch.status === 'completed'
        ? 100
        : 0
  return json({ ...batch, progress }, correlationId)
})
