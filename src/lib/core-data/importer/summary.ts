// Brief 45 (PR F): the facts behind the import page's summary [brief §5.7,
// §5.8], read from the database every time (nothing extra is stored):
//   - the list the upload fills;
//   - people, not rows: the leads the upload wrote (it stamps source
//     import:<id>; its list keeps "added by import:<id>"), split into new ones
//     (created no earlier than the upload) and ones already in the CRM;
//   - where the new people's ranking stands (summary-view.ts ScoringState).
// Never the token hash, the mapping or the file.
import type { PrismaClient } from '@prisma/client'
import { SCORE_WINDOW_MS } from '@/lib/core-data/dealflow-score/driver'
import type { ImportSummaryDTO, ScoringState } from './summary-view'

interface Counts {
  new: number
  existing: number
  noMojo: number
  ranked: number
  noMatch: number
  notScored: number
}

export async function getImportSummary(
  db: PrismaClient,
  organizationId: string,
  importId: string,
  now: Date = new Date(),
): Promise<ImportSummaryDTO | null> {
  const batch = await db.importBatch.findFirst({
    where: { id: importId, organizationId },
    select: { status: true, completedAt: true, targetListId: true, dealflowScoredAt: true, dealflowScoreError: true },
  })
  if (!batch) return null
  const list = batch.targetListId
    ? await db.callList.findFirst({
        where: { id: batch.targetListId, organizationId },
        select: { id: true, name: true, archivedAt: true, folder: { select: { name: true } } },
      })
    : null
  const targetList = list ? { id: list.id, name: list.name, folderName: list.folder?.name ?? null, archived: list.archivedAt !== null } : null
  if (batch.status !== 'completed') return { targetList, people: null, scoring: null }

  // The upload's people: the leads it stamped (source import:<id>), and the
  // leads it put on its list. A later upload that merges the same person
  // re-stamps the source, but the list keeps "added by import:<id>", so these
  // counts don't change afterwards. New = created no earlier than the upload.
  // "Scored after the upload" = DealFlow wrote the lead after the import
  // finished (this upload's scoring, or a later morning update).
  const [c] = await db.$queryRaw<Counts[]>`
    WITH b AS (SELECT * FROM "ImportBatch" WHERE id = ${importId}),
    people AS (
      SELECT l.id FROM "Lead" l JOIN b ON l."organizationId" = b."organizationId" AND l.source = 'import:' || b.id
      UNION
      SELECT m."leadId" FROM "ListMembership" m JOIN b ON m."listId" = b."targetListId" AND m."addedBy" = 'import:' || b.id
    )
    SELECT
      count(*) FILTER (WHERE l."createdAt" >= b."createdAt")::int AS "new",
      count(*) FILTER (WHERE l."createdAt" < b."createdAt")::int AS "existing",
      count(*) FILTER (WHERE l."createdAt" >= b."createdAt" AND COALESCE(l."mojoId", '') = '')::int AS "noMojo",
      count(*) FILTER (WHERE l."createdAt" >= b."createdAt" AND l."dealflowSignalSyncedAt" >= b."completedAt"
                         AND l."priorityScore" IS NOT NULL)::int AS "ranked",
      count(*) FILTER (WHERE l."createdAt" >= b."createdAt" AND l."dealflowSignalSyncedAt" >= b."completedAt"
                         AND l."priorityScore" IS NULL)::int AS "noMatch",
      count(*) FILTER (WHERE l."createdAt" >= b."createdAt" AND COALESCE(l."mojoId", '') <> ''
                         AND (l."dealflowSignalSyncedAt" IS NULL OR l."dealflowSignalSyncedAt" < b."completedAt"))::int AS "notScored"
    FROM people p
    JOIN "Lead" l ON l.id = p.id
    JOIN b ON l."organizationId" = b."organizationId"`

  let state: ScoringState
  if (batch.dealflowScoredAt) state = 'done'
  else if (batch.dealflowScoreError) state = 'failed'
  else if (c.new === 0) state = 'not_needed'
  else if (batch.completedAt && now.getTime() - batch.completedAt.getTime() < SCORE_WINDOW_MS) state = 'pending'
  else state = 'missed'

  return {
    targetList,
    people: { new: c.new, existing: c.existing, newWithoutMojoId: c.noMojo },
    scoring: { state, error: batch.dealflowScoreError, ranked: c.ranked, noMatch: c.noMatch, notScored: c.notScored },
  }
}
