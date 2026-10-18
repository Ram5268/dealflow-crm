// Brief 45 — groups: flat labels clicked onto a lead (Hot, Nurture, ...).
// Many-to-many: a lead is normally in one group, but may be in two
// [Ryan, 2026-10-18]. Adding to or removing from a group never touches list
// membership [Ryan, 2026-10-18], and deleting a group removes the labels,
// never the leads [brief §5.1]. Every real change writes a timeline entry in
// the same transaction [brief §5.3; CONTRACT §5].
import { Prisma, type PrismaClient } from '@prisma/client'
import { prisma } from '@/lib/prisma'
import type { BulkAddResult, BulkRemoveResult, GroupColor, GroupDTO } from './types'
import { COLOR_ERROR, isGroupColor } from './rules'
import {
  GROUP_SCOPE, STALE_ORDER, TX, badRequest, conflict, findClash, lockScope, notFound, sameSet, uniqueIds, utc, validName, type Tx,
} from './sql'
import { addedTo, removedByDelete, removedFrom, writeGroupEntries } from './timeline'

type Db = Tx | PrismaClient

const groupClash = (name: string) => conflict(`A group named "${name}" already exists.`)

function validColor(raw: unknown): GroupColor {
  if (!isGroupColor(raw)) throw badRequest(COLOR_ERROR)
  return raw
}

async function assertGroupName(tx: Tx, organizationId: string, name: string, selfId: string | null): Promise<void> {
  const rows = await tx.leadGroup.findMany({ where: { organizationId }, select: { id: true, name: true } })
  const clash = findClash(rows, name, selfId)
  if (clash) throw groupClash(clash.name)
}

const GROUP_SELECT = {
  id: true, name: true, color: true, sortOrder: true, _count: { select: { memberships: true } },
} satisfies Prisma.LeadGroupSelect

function toDTO(g: Prisma.LeadGroupGetPayload<{ select: typeof GROUP_SELECT }>): GroupDTO {
  return { id: g.id, name: g.name, color: isGroupColor(g.color) ? g.color : 'gray', sortOrder: g.sortOrder, memberCount: g._count.memberships }
}

async function getGroupDTO(db: Db, id: string): Promise<GroupDTO> {
  return toDTO(await db.leadGroup.findUniqueOrThrow({ where: { id }, select: GROUP_SELECT }))
}

/** Every group of the org, in sidebar order (the order of the chips on a card). */
export async function listGroups(organizationId: string, db: PrismaClient = prisma): Promise<GroupDTO[]> {
  const rows = await db.leadGroup.findMany({
    where: { organizationId },
    orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }, { id: 'asc' }],
    select: GROUP_SELECT,
  })
  return rows.map(toDTO)
}

async function findGroup(db: Db, organizationId: string, id: string): Promise<{ id: string; name: string }> {
  const group = await db.leadGroup.findFirst({ where: { id, organizationId }, select: { id: true, name: true } })
  if (!group) throw notFound('Group')
  return group
}

async function assertLead(db: Db, organizationId: string, leadId: string): Promise<void> {
  const lead = await db.lead.findFirst({ where: { id: leadId, organizationId }, select: { id: true } })
  if (!lead) throw notFound('Lead')
}

// Insert memberships for the org's leads among `leadIds`; returns the leads
// that were really added (others were already in, or aren't this org's).
async function insertMembers(tx: Tx, organizationId: string, groupId: string, leadIds: string[], addedBy: string, at: Date): Promise<{ valid: number; added: string[] }> {
  if (leadIds.length === 0) return { valid: 0, added: [] }
  const rows = await tx.$queryRaw<{ leadId: string | null; valid: number }[]>`
    WITH valid AS (
      SELECT l.id FROM "Lead" l WHERE l.id = ANY(${leadIds}::text[]) AND l."organizationId" = ${organizationId}
    ), ins AS (
      INSERT INTO "LeadGroupMembership" ("groupId", "leadId", "addedAt", "addedBy")
      SELECT ${groupId}, v.id, ${utc(at)}, ${addedBy} FROM valid v
      ON CONFLICT DO NOTHING
      RETURNING "leadId"
    )
    SELECT ins."leadId", (SELECT count(*)::int FROM valid) AS valid
    FROM (SELECT 1) one LEFT JOIN ins ON true`
  return { valid: rows[0]?.valid ?? 0, added: rows.map((r) => r.leadId).filter((id): id is string => id !== null) }
}

async function deleteMembers(tx: Tx, groupId: string, leadIds: string[]): Promise<string[]> {
  if (leadIds.length === 0) return []
  const rows = await tx.$queryRaw<{ leadId: string }[]>`
    DELETE FROM "LeadGroupMembership" WHERE "groupId" = ${groupId} AND "leadId" = ANY(${leadIds}::text[])
    RETURNING "leadId"`
  return rows.map((r) => r.leadId)
}

export interface CreateGroupInput {
  name: unknown
  color?: unknown
  /** The card's "+" chip: create the group and add this lead in one step. */
  leadId?: string
}

export async function createGroup(organizationId: string, input: CreateGroupInput, db: PrismaClient = prisma): Promise<{ group: GroupDTO; added: number }> {
  const name = validName(input.name)
  const color = input.color === undefined ? 'gray' : validColor(input.color)
  return db.$transaction(async (tx) => {
    await lockScope(tx, organizationId, GROUP_SCOPE)
    await assertGroupName(tx, organizationId, name, null)
    if (input.leadId !== undefined) await assertLead(tx, organizationId, input.leadId)
    const last = await tx.leadGroup.aggregate({ where: { organizationId }, _max: { sortOrder: true } })
    const group = await tx.leadGroup.create({ data: { organizationId, name, color, sortOrder: (last._max.sortOrder ?? -1) + 1 } })
    let added = 0
    if (input.leadId !== undefined) {
      const at = new Date()
      const r = await insertMembers(tx, organizationId, group.id, [input.leadId], 'manual', at)
      await writeGroupEntries(tx, organizationId, r.added, addedTo(group.name), at)
      added = r.added.length
    }
    return { group: await getGroupDTO(tx, group.id), added }
  }, TX)
}

export async function updateGroup(organizationId: string, id: string, input: { name?: unknown; color?: unknown }, db: PrismaClient = prisma): Promise<GroupDTO> {
  const name = input.name === undefined ? undefined : validName(input.name)
  const color = input.color === undefined ? undefined : validColor(input.color)
  return db.$transaction(async (tx) => {
    if (name !== undefined) await lockScope(tx, organizationId, GROUP_SCOPE)
    const group = await findGroup(tx, organizationId, id)
    if (name !== undefined) await assertGroupName(tx, organizationId, name, id)
    const data = { ...(name !== undefined && name !== group.name ? { name } : {}), ...(color !== undefined ? { color } : {}) }
    if (Object.keys(data).length > 0) await tx.leadGroup.update({ where: { id }, data })
    return getGroupDTO(tx, id)
  }, TX)
}

export async function deleteGroup(organizationId: string, id: string, db: PrismaClient = prisma): Promise<{ deleted: true; membershipsRemoved: number }> {
  return db.$transaction(async (tx) => {
    const group = await findGroup(tx, organizationId, id)
    const members = await tx.leadGroupMembership.findMany({ where: { groupId: id }, select: { leadId: true } })
    await writeGroupEntries(tx, organizationId, members.map((m) => m.leadId), removedByDelete(group.name), new Date())
    // Cascades to LeadGroupMembership only. Leads are never touched.
    await tx.leadGroup.delete({ where: { id } })
    return { deleted: true as const, membershipsRemoved: members.length }
  }, TX)
}

/** `ids` = every group of the org, in the new order. */
export async function reorderGroups(organizationId: string, ids: string[], db: PrismaClient = prisma): Promise<{ ok: true }> {
  return db.$transaction(async (tx) => {
    await lockScope(tx, organizationId, GROUP_SCOPE)
    const current = await tx.leadGroup.findMany({ where: { organizationId }, select: { id: true } })
    if (!sameSet(current.map((g) => g.id), ids)) throw STALE_ORDER
    await tx.$executeRaw`
      UPDATE "LeadGroup" g SET "sortOrder" = (o.ord - 1)::int, "updatedAt" = ${utc(new Date())}
      FROM unnest(${ids}::text[]) WITH ORDINALITY AS o(id, ord)
      WHERE g.id = o.id AND g."organizationId" = ${organizationId}`
    return { ok: true as const }
  }, TX)
}

/** One click on a chip: add. Idempotent. */
export async function addLeadToGroup(organizationId: string, groupId: string, leadId: string, db: PrismaClient = prisma): Promise<{ changed: boolean }> {
  return db.$transaction(async (tx) => {
    const group = await findGroup(tx, organizationId, groupId)
    await assertLead(tx, organizationId, leadId)
    const at = new Date()
    const r = await insertMembers(tx, organizationId, groupId, [leadId], 'manual', at)
    await writeGroupEntries(tx, organizationId, r.added, addedTo(group.name), at)
    return { changed: r.added.length > 0 }
  }, TX)
}

/** A second click: remove. Idempotent. */
export async function removeLeadFromGroup(organizationId: string, groupId: string, leadId: string, db: PrismaClient = prisma): Promise<{ changed: boolean }> {
  return db.$transaction(async (tx) => {
    const group = await findGroup(tx, organizationId, groupId)
    await assertLead(tx, organizationId, leadId)
    const removed = await deleteMembers(tx, groupId, [leadId])
    await writeGroupEntries(tx, organizationId, removed, removedFrom(group.name), new Date())
    return { changed: removed.length > 0 }
  }, TX)
}

export async function addGroupMembers(organizationId: string, groupId: string, leadIds: readonly string[], db: PrismaClient = prisma): Promise<BulkAddResult> {
  const ids = uniqueIds(leadIds)
  return db.$transaction(async (tx) => {
    const group = await findGroup(tx, organizationId, groupId)
    const at = new Date()
    const r = await insertMembers(tx, organizationId, groupId, ids, 'bulk', at)
    await writeGroupEntries(tx, organizationId, r.added, addedTo(group.name), at)
    return { added: r.added.length, alreadyIn: r.valid - r.added.length, notFound: ids.length - r.valid }
  }, TX)
}

export async function removeGroupMembers(organizationId: string, groupId: string, leadIds: readonly string[], db: PrismaClient = prisma): Promise<BulkRemoveResult> {
  const ids = uniqueIds(leadIds)
  return db.$transaction(async (tx) => {
    const group = await findGroup(tx, organizationId, groupId)
    const removed = await deleteMembers(tx, groupId, ids)
    await writeGroupEntries(tx, organizationId, removed, removedFrom(group.name), new Date())
    return { removed: removed.length }
  }, TX)
}

/**
 * A Pipeline drag from column X to column Y: out of X, into Y, in one
 * transaction, with a timeline entry for each real change. A stale card (no
 * longer in X, or already in Y) changes only what's needed.
 */
export async function moveLeadBetweenGroups(
  organizationId: string,
  input: { leadId: string; fromGroupId: string; toGroupId: string },
  db: PrismaClient = prisma,
): Promise<{ ok: true; removed: boolean; added: boolean }> {
  if (input.fromGroupId === input.toGroupId) throw badRequest('Pick two different groups.')
  return db.$transaction(async (tx) => {
    const from = await findGroup(tx, organizationId, input.fromGroupId)
    const to = await findGroup(tx, organizationId, input.toGroupId)
    await assertLead(tx, organizationId, input.leadId)
    const at = new Date()
    const removed = await deleteMembers(tx, from.id, [input.leadId])
    await writeGroupEntries(tx, organizationId, removed, removedFrom(from.name), at)
    // A millisecond later, so the timeline reads "Added to Y" above "Removed from X".
    const later = new Date(at.getTime() + 1)
    const added = await insertMembers(tx, organizationId, to.id, [input.leadId], 'pipeline', later)
    await writeGroupEntries(tx, organizationId, added.added, addedTo(to.name), later)
    return { ok: true as const, removed: removed.length > 0, added: added.added.length > 0 }
  }, TX)
}
