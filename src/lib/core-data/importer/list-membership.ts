// Brief 45 (PR F): an upload fills its list [brief §5.7]. Every row's lead,
// whether the row made a new lead or merged into one already in the CRM, gets
// a ListMembership on the upload's target list, added by 'import:<id>'.
// One person is one lead [Ryan, 2026-10-18; Oct 16 import rule]: the merge
// decides which lead a row is (commit-worker.ts, unchanged), and the list just
// points at it. Idempotent: someone already on the list keeps their row (and
// how they were added), so re-runs and resumes add nothing twice.
import type { PrismaClient } from '@prisma/client'
import { insertListMembers } from '@/lib/core-data/lists/memberships'

export const importAddedBy = (importId: string) => `import:${importId}`

export interface AddToListResult {
  added: number
  /** The list was deleted (or isn't this organization's): its people stay in the CRM, nothing is added. */
  listGone: boolean
}

const listExists = async (db: PrismaClient, organizationId: string, listId: string) =>
  !!(await db.callList.findFirst({ where: { id: listId, organizationId }, select: { id: true } }))

/**
 * Puts `leadIds` (the organization's leads among them) on the list. With
 * everyImportedLead, also every lead the import stamped (Lead.source =
 * 'import:<id>', set on every row it wrote): the end of a commit uses it, so
 * rows a stopped run already did, before a resume, are on the list too.
 */
export async function addImportLeadsToList(
  db: PrismaClient,
  organizationId: string,
  listId: string,
  importId: string,
  leadIds: readonly string[],
  opts: { everyImportedLead?: boolean } = {},
): Promise<AddToListResult> {
  if (!(await listExists(db, organizationId, listId))) return { added: 0, listGone: true }
  const ids = new Set(leadIds)
  if (opts.everyImportedLead) {
    const stamped = await db.lead.findMany({ where: { organizationId, source: `import:${importId}` }, select: { id: true } })
    for (const l of stamped) ids.add(l.id)
  }
  if (ids.size === 0) return { added: 0, listGone: false }
  try {
    const { added } = await insertListMembers(db, organizationId, listId, [...ids], importAddedBy(importId))
    return { added, listGone: false }
  } catch (err) {
    // Deleted while this ran (the membership's foreign key refused it).
    if (!(await listExists(db, organizationId, listId))) return { added: 0, listGone: true }
    throw err
  }
}
