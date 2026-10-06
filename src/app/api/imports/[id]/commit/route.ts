import { z } from 'zod'
import { after, type NextRequest } from 'next/server'
import { prisma } from '@/lib/prisma'
import { getCurrentOrgId } from '@/lib/shell/orgContext'
import { withRoute, json, parseBody, HttpError } from '@/lib/shared/http'
import { mappingProposalSchema } from '@/lib/core-data/importer/ai-mapping'
import { enqueueImportCommit } from '@/lib/core-data/importer/enqueue'
import { claimImportCommit } from '@/lib/core-data/importer/batch'

export const runtime = 'nodejs'
// The inline commit runs in after() and needs the time (same cap as the sync cron).
export const maxDuration = 300

const commitSchema = z.object({
  mapping: mappingProposalSchema,
  duplicateStrategy: z.enum(['skip', 'merge', 'add-anyway']).default('merge'),
})

// POST /api/imports/:id/commit → 202 Accepted; the commit runs after the
// response. Brief 41: the batch is claimed atomically first, so a second click
// or a retried request gets 409 instead of starting a parallel commit, and an
// import that already ran is never run again.
export const POST = withRoute(async (req: NextRequest, { correlationId, params }) => {
  const organizationId = await getCurrentOrgId()
  const body = await parseBody(req, commitSchema)

  const claim = await claimImportCommit(prisma, params!.id, organizationId, body.mapping)
  if (!claim.claimed) {
    if (claim.status === null) throw new HttpError(404, 'ImportBatch not found')
    throw new HttpError(409, claim.status === 'completed' ? 'This import has already run.' : 'This import is already running.')
  }

  after(() =>
    enqueueImportCommit({
      importBatchId: params!.id,
      duplicateStrategy: body.duplicateStrategy,
      mapping: body.mapping,
      correlationId,
    })
  )

  return json({ status: 'importing' }, correlationId, { status: 202 })
})
