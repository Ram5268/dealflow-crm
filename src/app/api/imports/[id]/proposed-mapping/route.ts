import type { NextRequest } from 'next/server'
import { prisma } from '@/lib/prisma'
import { getCurrentOrgId } from '@/lib/shell/orgContext'
import { withRoute, json, HttpError, errorResponse } from '@/lib/shared/http'
import { getObject } from '@/lib/core-data/importer/storage'
import { parseFile } from '@/lib/core-data/importer/parser'
import { proposeMapping, defaultAnthropicCaller } from '@/lib/core-data/importer/ai-mapping'
import { captureException } from '@/lib/shared/sentry'
import { logger } from '@/lib/logger'
import { ZodError } from 'zod'

export const runtime = 'nodejs'

// POST /api/imports/:id/proposed-mapping — AI column mapping via Sonnet 4.6.
export const POST = withRoute(async (_req: NextRequest, { correlationId, params }) => {
  const organizationId = await getCurrentOrgId()
  const batch = await prisma.importBatch.findFirst({ where: { id: params!.id, organizationId } })
  if (!batch) throw new HttpError(404, 'ImportBatch not found')

  const buffer = await getObject(batch.storageKey)
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

  await prisma.importBatch.update({
    where: { id: batch.id },
    data: { mappingJson: proposal as object, status: 'mapping_review', totalRows: parsed.totalRowsDetected },
  })

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
