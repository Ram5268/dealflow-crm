import { z } from 'zod'
import { after, type NextRequest } from 'next/server'
import { prisma } from '@/lib/prisma'
import { getCurrentOrgId } from '@/lib/shell/orgContext'
import { withRoute, json, parseBody, HttpError } from '@/lib/shared/http'
import { mappingProposalSchema } from '@/lib/core-data/importer/ai-mapping'
import { enqueueImportCommit } from '@/lib/core-data/importer/enqueue'
import { claimImportCommit } from '@/lib/core-data/importer/batch'
import { checkMapping } from '@/lib/core-data/importer/mapping-edit'

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
// import that already ran is never run again. Brief 41.1: the claim starts a
// run (its id goes to the commit, which only writes while it holds the
// import); a re-run waits a minute after a "stopped responding" failure.
export const POST = withRoute(async (req: NextRequest, { correlationId, params }) => {
  const organizationId = await getCurrentOrgId()
  const body = await parseBody(req, commitSchema)
  // Brief 50 PR 6: the mapping can be changed on the review screen. The
  // screen's own checks run here too, before anything starts: nothing to match
  // a row on (every row would be skipped), or one custom field fed by two
  // columns (a merge writing both would fail the row) — with the org's custom
  // fields, as on the screen, so a new field named like an existing one counts
  // as that field.
  const customFields = (
    await prisma.customFieldDefinition.findMany({
      where: { organizationId, objectType: 'lead' },
      select: { id: true, name: true, type: true },
    })
  ).map((d) => ({ definitionId: d.id, name: d.name, type: d.type }))
  const [problem] = checkMapping(body.mapping.mapping, customFields).problems
  if (problem) throw new HttpError(400, problem)

  const claim = await claimImportCommit(prisma, params!.id, organizationId, body.mapping)
  if (!claim.claimed) {
    if (claim.status === null) throw new HttpError(404, 'ImportBatch not found')
    if (claim.retryInSeconds) {
      throw new HttpError(
        409,
        `The last run of this import is still stopping. Try again in about ${claim.retryInSeconds} seconds.`,
        { retryInSeconds: claim.retryInSeconds }
      )
    }
    throw new HttpError(409, claim.status === 'completed' ? 'This import has already run.' : 'This import is already running.')
  }

  after(() =>
    enqueueImportCommit({
      importBatchId: params!.id,
      duplicateStrategy: body.duplicateStrategy,
      mapping: body.mapping,
      correlationId,
      runId: claim.runId,
    })
  )

  return json({ status: 'importing' }, correlationId, { status: 202 })
})
