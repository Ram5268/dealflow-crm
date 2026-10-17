import type { NextRequest } from 'next/server'
import { prisma } from '@/lib/prisma'
import { getCurrentOrgId } from '@/lib/shell/orgContext'
import { withRoute, json, HttpError, errorResponse } from '@/lib/shared/http'
import { getObject } from '@/lib/core-data/importer/storage'
import { parseFile } from '@/lib/core-data/importer/parser'
import { proposeMapping, defaultAnthropicCaller } from '@/lib/core-data/importer/ai-mapping'
import { isStalled, sameMappingJson } from '@/lib/core-data/importer/batch'
import { FILE_GONE_MESSAGE } from '@/lib/core-data/importer/progress-view'
import { captureException } from '@/lib/shared/sentry'
import { logger } from '@/lib/logger'
import { ZodError } from 'zod'

export const runtime = 'nodejs'

// POST /api/imports/:id/proposed-mapping — AI column mapping via Sonnet 4.6.
export const POST = withRoute(async (_req: NextRequest, { correlationId, params }) => {
  const organizationId = await getCurrentOrgId()
  const batch = await prisma.importBatch.findFirst({ where: { id: params!.id, organizationId } })
  if (!batch) throw new HttpError(404, 'ImportBatch not found')
  // Brief 41: revisiting the mapping page must not reset an import that is
  // running or finished (that reset let the same file be committed twice).
  // Brief 41.1: an import stuck at 'importing' with no progress for 10 minutes
  // has no live run, so "Back to the import" may reopen it (no re-upload).
  const stalled = isStalled(batch, Date.now())
  if (batch.status === 'completed' || (batch.status === 'importing' && !stalled)) {
    throw new HttpError(409, batch.status === 'completed' ? 'This import has already run.' : 'This import is already running.')
  }

  // A file cleared by the 24 h sweep: say to upload it again (not a 500).
  const buffer = await getObject(batch.storageKey).catch((err: unknown) => {
    if (err instanceof Error && /no stored bytes/.test(err.message)) throw new HttpError(410, FILE_GONE_MESSAGE)
    throw err
  })
  const parsed = parseFile(buffer, batch.filename)
  const existingDefs = await prisma.customFieldDefinition.findMany({
    where: { organizationId, objectType: 'lead' },
    select: { id: true, name: true, type: true },
  })
  const existing = existingDefs.map((d) => ({ definitionId: d.id, name: d.name, type: d.type }))

  let proposal
  try {
    proposal = await proposeMapping(parsed, existing, defaultAnthropicCaller())
  } catch (err) {
    captureException(err, { dependency: 'anthropic', event: 'proposed-mapping' })
    // A ZodError here means the response was unusable even after coercion —
    // that is a bad payload, not an outage, so it must not present as 503
    // ("retry" is useless advice when a retry produces the same shape).
    const unusable = err instanceof ZodError
    return errorResponse(
      unusable
        ? 'AI returned a mapping we could not read. Map the columns manually to continue.'
        : 'AI mapping unavailable, retry',
      unusable ? 400 : 503,
      correlationId
    )
  }

  if (proposal.coercedColumns.length > 0) {
    // Never silent: the model got these wrong and we rewrote them, so both the
    // logs and the reviewer see exactly which columns were touched.
    logger.warn(
      { event: 'proposed-mapping.coerced', importBatchId: batch.id, coerced: proposal.coercedColumns },
      'AI mapping returned out-of-enum target.kind values; coerced'
    )
  }

  // Conditional: a commit may have started while the AI call ran (another tab).
  // A stalled import is reopened only if it is still that same stalled run;
  // its errors and resume point are cleared, so the re-run starts fresh (its
  // counts may be ahead of that point; rows already imported are merged).
  const { count } = await prisma.importBatch.updateMany({
    where: stalled
      ? { id: batch.id, status: 'importing', mappingJson: sameMappingJson(batch.mappingJson) }
      : { id: batch.id, status: { notIn: ['importing', 'completed'] } },
    data: {
      mappingJson: proposal as object,
      status: 'mapping_review',
      totalRows: parsed.totalRowsDetected,
      ...(stalled ? { errorLog: [] } : {}),
    },
  })
  if (count === 0) throw new HttpError(409, 'This import has already started.')

  return json(
    {
      mapping: proposal.mapping,
      likelyDuplicates: proposal.likelyDuplicates,
      coercedColumns: proposal.coercedColumns,
      headerRow: parsed.headerRow,
      totalRowsDetected: parsed.totalRowsDetected,
    },
    correlationId
  )
})
