import { z } from 'zod'
import type { NextRequest } from 'next/server'
import { prisma } from '@/lib/prisma'
import { getCurrentOrgId } from '@/lib/shell/orgContext'
import { withRoute, json, parseBody, HttpError } from '@/lib/shared/http'
import { mappingProposalSchema } from '@/lib/core-data/importer/ai-mapping'
import { enqueueImportCommit } from '@/lib/core-data/importer/enqueue'

export const runtime = 'nodejs'

const commitSchema = z.object({
  mapping: mappingProposalSchema,
  duplicateStrategy: z.enum(['skip', 'merge', 'add-anyway']).default('merge'),
})

// POST /api/imports/:id/commit → 202 Accepted; commit runs as a background job.
export const POST = withRoute(async (req: NextRequest, { correlationId, params }) => {
  const organizationId = await getCurrentOrgId()
  const batch = await prisma.importBatch.findFirst({ where: { id: params!.id, organizationId } })
  if (!batch) throw new HttpError(404, 'ImportBatch not found')

  const body = await parseBody(req, commitSchema)
  await prisma.importBatch.update({
    where: { id: batch.id },
    data: { mappingJson: body.mapping as object, status: 'importing' },
  })

  await enqueueImportCommit({
    importBatchId: batch.id,
    duplicateStrategy: body.duplicateStrategy,
    mapping: body.mapping,
    correlationId,
  })

  return json({ status: 'importing' }, correlationId, { status: 202 })
})
