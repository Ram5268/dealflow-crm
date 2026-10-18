// Brief 45 — who is on which list. One person is one lead [Ryan, 2026-10-18;
// Oct 16 import rule]: a membership points at Lead.id, so someone on two lists
// is the same row everywhere. Only removing someone from a list takes them out
// of that list's call order [Ryan, 2026-10-18]. Adds and removes are
// idempotent and report counts; another organization's leads count as
// notFound and are never added [CONTRACT §2].
import type { PrismaClient } from '@prisma/client'
import { prisma } from '@/lib/prisma'
import type { BulkAddResult, BulkRemoveResult, LeadMemberships } from './types'
import { notFound, uniqueIds, utc, type Tx } from './sql'

type Db = Tx | PrismaClient

/** Insert memberships for the org's leads among `leadIds` (already de-duplicated). */
export async function insertListMembers(
  db: Db,
  organizationId: string,
  listId: string,
  leadIds: string[],
  addedBy: string,
): Promise<BulkAddResult> {
  if (leadIds.length === 0) return { added: 0, alreadyIn: 0, notFound: 0 }
  const [r] = await db.$queryRaw<{ valid: number; added: number }[]>`
    WITH valid AS (
      SELECT l.id FROM "Lead" l WHERE l.id = ANY(${leadIds}::text[]) AND l."organizationId" = ${organizationId}
    ), ins AS (
      INSERT INTO "ListMembership" ("listId", "leadId", "addedAt", "addedBy")
      SELECT ${listId}, v.id, ${utc(new Date())}, ${addedBy} FROM valid v
      ON CONFLICT DO NOTHING
      RETURNING "leadId"
    )
    SELECT (SELECT count(*)::int FROM valid) AS valid, (SELECT count(*)::int FROM ins) AS added`
  return { added: r.added, alreadyIn: r.valid - r.added, notFound: leadIds.length - r.valid }
}

async function assertList(db: Db, organizationId: string, listId: string): Promise<void> {
  const list = await db.callList.findFirst({ where: { id: listId, organizationId }, select: { id: true } })
  if (!list) throw notFound('List')
}

export async function addListMembers(
  organizationId: string,
  listId: string,
  leadIds: readonly string[],
  opts: { addedBy?: string } = {},
  db: PrismaClient = prisma,
): Promise<BulkAddResult> {
  const ids = uniqueIds(leadIds)
  await assertList(db, organizationId, listId)
  return insertListMembers(db, organizationId, listId, ids, opts.addedBy ?? 'bulk')
}

export async function removeListMembers(
  organizationId: string,
  listId: string,
  leadIds: readonly string[],
  db: PrismaClient = prisma,
): Promise<BulkRemoveResult> {
  const ids = uniqueIds(leadIds)
  await assertList(db, organizationId, listId)
  if (ids.length === 0) return { removed: 0 }
  const { count } = await db.listMembership.deleteMany({ where: { listId, leadId: { in: ids } } })
  return { removed: count }
}

/** The lead's active lists and its groups, both in sidebar order (the contact card's chips). */
export async function getLeadMemberships(organizationId: string, leadId: string, db: PrismaClient = prisma): Promise<LeadMemberships> {
  const lead = await db.lead.findFirst({ where: { id: leadId, organizationId }, select: { id: true } })
  if (!lead) throw notFound('Lead')
  const [lists, groups] = await Promise.all([
    db.$queryRaw<{ id: string; name: string; folderName: string | null }[]>`
      SELECT cl.id, cl.name, f.name AS "folderName"
      FROM "ListMembership" m
      JOIN "CallList" cl ON cl.id = m."listId" AND cl."organizationId" = ${organizationId} AND cl."archivedAt" IS NULL
      LEFT JOIN "Folder" f ON f.id = cl."folderId"
      WHERE m."leadId" = ${leadId}
      ORDER BY (f.id IS NULL), f."sortOrder", f."createdAt", f.id, cl."sortOrder", cl."createdAt", cl.id`,
    db.$queryRaw<{ id: string }[]>`
      SELECT g.id FROM "LeadGroupMembership" gm
      JOIN "LeadGroup" g ON g.id = gm."groupId" AND g."organizationId" = ${organizationId}
      WHERE gm."leadId" = ${leadId}
      ORDER BY g."sortOrder", g."createdAt", g.id`,
  ])
  return { lists, groupIds: groups.map((g) => g.id) }
}
