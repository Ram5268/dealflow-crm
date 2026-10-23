import type { NextRequest } from 'next/server'
import { prisma } from '@/lib/prisma'
import { getCurrentOrgId } from '@/lib/shell/orgContext'
import { withRoute, json, HttpError } from '@/lib/shared/http'
import { getObject } from '@/lib/core-data/importer/storage'
import { parseFile, tabsForReview } from '@/lib/core-data/importer/parser'
import { defaultAnthropicCaller } from '@/lib/core-data/importer/ai-mapping'
import { isStalled, sameMappingJson } from '@/lib/core-data/importer/batch'
import { FILE_GONE_MESSAGE } from '@/lib/core-data/importer/progress-view'
import { proposalForReview, savedProposal } from '@/lib/core-data/importer/review-proposal'
import { captureException } from '@/lib/shared/sentry'
import { logger } from '@/lib/logger'

export const runtime = 'nodejs'

// Marks a mapping put back on the review screen from a stopped run, so a
// reload of the screen keeps showing it (Brief 50 PR 6).
const FROM_LAST_RUN = 'fromLastRun'

// POST /api/imports/:id/proposed-mapping — AI column mapping via Sonnet 4.6.
// Brief 50 PR 6: the screen always opens. With no usable AI answer every
// column starts on "Don't import" and Ryan picks each field (the old answer,
// "Map the columns manually to continue", pointed to a screen that didn't
// exist). "Back to the import" after a stopped run shows the mapping that run
// committed (with Ryan's changes) rather than asking the AI again.
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
    orderBy: [{ displayOrder: 'asc' }, { name: 'asc' }],
  })
  const existing = existingDefs.map((d) => ({ definitionId: d.id, name: d.name, type: d.type }))

  // A stopped run (failed, or stuck at 'importing') committed this mapping;
  // so did one put back on the screen from it.
  const lastRun =
    batch.status === 'failed' || stalled || (batch.status === 'mapping_review' && (batch.mappingJson as Record<string, unknown> | null)?.[FROM_LAST_RUN] === true)
  const proposal = await proposalForReview({
    parsed,
    existing,
    caller: defaultAnthropicCaller(),
    saved: lastRun ? savedProposal(batch.mappingJson) : null,
  })
  const { source, notice, error, ...mapping } = proposal

  if (error !== undefined) captureException(error, { dependency: 'anthropic', event: 'proposed-mapping' })
  if (mapping.coercedColumns.length > 0) {
    // Never silent: the model got these wrong and we rewrote them, so both the
    // logs and the reviewer see exactly which columns were touched.
    logger.warn(
      { event: 'proposed-mapping.coerced', importBatchId: batch.id, coerced: mapping.coercedColumns },
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
      mappingJson: (source === 'last-run' ? { ...mapping, [FROM_LAST_RUN]: true } : mapping) as object,
      status: 'mapping_review',
      totalRows: parsed.totalRowsDetected,
      ...(stalled ? { errorLog: [] } : {}),
    },
  })
  if (count === 0) throw new HttpError(409, 'This import has already started.')

  return json(
    {
      mapping: mapping.mapping,
      likelyDuplicates: mapping.likelyDuplicates,
      coercedColumns: mapping.coercedColumns,
      headerRow: parsed.headerRow,
      totalRowsDetected: parsed.totalRowsDetected,
      // Brief 50 PR 6: where the screen's mapping came from, why (in plain
      // English), and the custom fields a column may be put into.
      source,
      notice,
      customFields: existing,
      // Brief 50 PR 20: an Excel file's tabs that aren't imported (only the
      // first visible tab is) and whether that tab hit the row limit; null for
      // a CSV. Re-read from the file on every visit, like the rows: nothing
      // new is stored, and the tab names are never logged.
      tabs: tabsForReview(parsed),
    },
    correlationId
  )
})
