// Brief 50 PR 6 (open item 6.6): "already in your CRM" before the commit.
//
// Read-only. Each row is planned and matched exactly as the commit does it
// (buildRowPlan, then findExistingLead: Mojo ID, then the first phone, then
// name + address), so the rows listed are the rows the commit merges into a
// lead that exists today. The merge itself is unchanged. Rows that repeat
// someone earlier in the same file aren't counted: they don't exist yet.
//
// The Mojo ID lookups for the whole file are made in one query per thousand
// IDs (the column is unique, so that is the same answer as one lookup per
// row); the rest run per row, a few at a time.
import type { PrismaClient } from '@prisma/client'
import type { ColumnMapping } from './ai-mapping'
import { MATCH_SELECT, buildRowPlan, findExistingLead, nothingToMatch, resolveMapping, type MatchRow } from './commit-worker'
import { MATCH_LIST_LIMIT, type DuplicateMatchDTO, type DuplicatePreviewDTO } from './duplicate-preview-view'

const MOJO_CHUNK = 1000
const CONCURRENCY = 8

export async function previewDuplicates(
  db: PrismaClient,
  organizationId: string,
  rows: Record<string, string>[],
  mapping: ColumnMapping[],
): Promise<DuplicatePreviewDTO> {
  // Custom fields don't decide who a row is.
  const resolved = resolveMapping(mapping, [])
  const plans = rows.map((row) => buildRowPlan(row, resolved))

  const byMojo = new Map<string, MatchRow | null>()
  const mojoIds = [...new Set(plans.flatMap((p) => (p.lead.mojoId ? [p.lead.mojoId] : [])))]
  for (let i = 0; i < mojoIds.length; i += MOJO_CHUNK) {
    const ids = mojoIds.slice(i, i + MOJO_CHUNK)
    for (const id of ids) byMojo.set(id, null)
    const leads = await db.lead.findMany({ where: { organizationId, mojoId: { in: ids } }, select: MATCH_SELECT })
    for (const lead of leads) if (lead.mojoId) byMojo.set(lead.mojoId, lead)
  }

  const found: Array<DuplicateMatchDTO | null> = new Array(plans.length).fill(null)
  let skipped = 0
  let cursor = 0
  const worker = async () => {
    while (cursor < plans.length) {
      const i = cursor++
      const plan = plans[i]
      if (nothingToMatch(plan)) {
        skipped++
        continue
      }
      const lead = await findExistingLead(db, organizationId, plan, { byMojo })
      if (!lead) continue
      const phone = plan.phones[0]?.phoneE164
      found[i] = {
        row: i + 2,
        name: plan.displayName,
        phoneLast4: phone ? phone.slice(-4) : null,
        leadId: lead.id,
        leadName: lead.displayName,
        via: lead.via,
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, plans.length) }, worker))

  const matches = found.filter((m): m is DuplicateMatchDTO => m !== null)
  return { totalRows: plans.length, existing: matches.length, unidentified: skipped, matches: matches.slice(0, MATCH_LIST_LIMIT) }
}
