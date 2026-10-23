import { z } from 'zod'
import type { NextRequest } from 'next/server'
import { prisma } from '@/lib/prisma'
import { getCurrentOrgId } from '@/lib/shell/orgContext'
import { withRoute, json, parseBody, HttpError } from '@/lib/shared/http'
import { getObject } from '@/lib/core-data/importer/storage'
import { parseFile } from '@/lib/core-data/importer/parser'
import { mappingProposalSchema } from '@/lib/core-data/importer/ai-mapping'
import { NOTHING_TO_MATCH, checkMapping } from '@/lib/core-data/importer/mapping-edit'
import { previewDuplicates } from '@/lib/core-data/importer/duplicate-preview'
import { FILE_GONE_MESSAGE } from '@/lib/core-data/importer/progress-view'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
// One lookup per row the commit would make (Mojo IDs in bulk). The check stops
// starting rows after PREVIEW_BUDGET_MS, well inside this limit.
export const maxDuration = 60
const PREVIEW_BUDGET_MS = 40_000

const bodySchema = z.object({ mapping: mappingProposalSchema })

// POST /api/imports/:id/duplicate-preview { mapping } → which rows of the file
// look like people already in the CRM, for the mapping on the review screen
// (Brief 50 PR 6, open item 6.6). Read-only: it plans and matches each row the
// way the commit does and writes nothing. A phone is shown by its last 4
// digits only. Behind the Basic auth gate like every page.
export const POST = withRoute(async (req: NextRequest, { correlationId, params }) => {
  const organizationId = await getCurrentOrgId()
  const body = await parseBody(req, bodySchema)
  if (checkMapping(body.mapping.mapping).problems.includes(NOTHING_TO_MATCH)) throw new HttpError(400, NOTHING_TO_MATCH)
  const batch = await prisma.importBatch.findFirst({
    where: { id: params!.id, organizationId },
    select: { storageKey: true, filename: true },
  })
  if (!batch) throw new HttpError(404, 'ImportBatch not found')
  const buffer = await getObject(batch.storageKey).catch((err: unknown) => {
    if (err instanceof Error && /no stored bytes/.test(err.message)) throw new HttpError(410, FILE_GONE_MESSAGE)
    throw err
  })
  const parsed = parseFile(buffer, batch.filename)
  const preview = await previewDuplicates(prisma, organizationId, parsed.allRows, body.mapping.mapping, {
    deadline: Date.now() + PREVIEW_BUDGET_MS,
    signal: req.signal,
  })
  return json(preview, correlationId)
})
