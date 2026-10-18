// Brief 45 — lists. A list sits in one folder or outside any folder
// [Ryan, 2026-10-18]. Names are unique within a folder and, separately, among
// lists outside folders; archived lists keep their name, so unarchiving can
// never make a duplicate [brief §5.1, the planner's design approved by Ryan
// 2026-10-18; CONTRACT §2]. Deleting or archiving a list never
// deletes a lead [brief §5.1]: only its memberships go.
import type { Prisma, PrismaClient } from '@prisma/client'
import { prisma } from '@/lib/prisma'
import type { ListDTO } from './types'
import {
  STALE_ORDER, TX, conflict, findClash, listScope, lockScope, notFound, sameSet, uniqueIds, utc, validName, type Tx,
} from './sql'
import { insertListMembers } from './memberships'

const listClash = (name: string, folderId: string | null) =>
  conflict(folderId ? `A list named "${name}" is already in this folder.` : `A list named "${name}" is already outside folders.`)

/** In the target scope, archived lists included. Call while holding listScope(folderId). */
async function assertListName(tx: Tx, organizationId: string, folderId: string | null, name: string, selfId: string | null): Promise<void> {
  const rows = await tx.callList.findMany({ where: { organizationId, folderId }, select: { id: true, name: true } })
  const clash = findClash(rows, name, selfId)
  if (clash) throw listClash(clash.name, folderId)
}

async function assertFolder(tx: Tx, organizationId: string, folderId: string | null): Promise<void> {
  if (folderId === null) return
  const folder = await tx.folder.findFirst({ where: { id: folderId, organizationId }, select: { id: true } })
  if (!folder) throw notFound('Folder')
}

async function nextSortOrder(tx: Tx, organizationId: string, folderId: string | null): Promise<number> {
  const last = await tx.callList.aggregate({ where: { organizationId, folderId }, _max: { sortOrder: true } })
  return (last._max.sortOrder ?? -1) + 1
}

const LIST_SELECT = {
  id: true, name: true, folderId: true, source: true, sortOrder: true, archivedAt: true, createdAt: true,
  folder: { select: { name: true, sortOrder: true, createdAt: true, id: true } },
  _count: { select: { memberships: true } },
} satisfies Prisma.CallListSelect

type ListRow = Prisma.CallListGetPayload<{ select: typeof LIST_SELECT }>

const importId = (source: string) => (source.startsWith('upload:') ? source.slice('upload:'.length) : null)

/** Sidebar order: folders in their order, then lists outside folders; within each, sortOrder. */
export function sidebarListOrder(a: ListRow, b: ListRow): number {
  const fa = a.folder
  const fb = b.folder
  if (!fa !== !fb) return fa ? -1 : 1
  if (fa && fb && fa.id !== fb.id) {
    return fa.sortOrder - fb.sortOrder || fa.createdAt.getTime() - fb.createdAt.getTime() || (fa.id < fb.id ? -1 : 1)
  }
  return a.sortOrder - b.sortOrder || a.createdAt.getTime() - b.createdAt.getTime() || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
}

async function toDTOs(db: Tx | PrismaClient, organizationId: string, rows: ListRow[]): Promise<(ListDTO & { folderName: string | null })[]> {
  const uploads = rows.map((r) => importId(r.source)).filter((id): id is string => id !== null)
  const batches = uploads.length
    ? await db.importBatch.findMany({ where: { organizationId, id: { in: uploads } }, select: { id: true, createdAt: true } })
    : []
  const uploadedAt = new Map(batches.map((b) => [b.id, b.createdAt.toISOString()]))
  return rows.map((r) => {
    const upload = importId(r.source)
    const at = upload ? uploadedAt.get(upload) : undefined
    return {
      id: r.id,
      name: r.name,
      folderId: r.folderId,
      source: r.source,
      sortOrder: r.sortOrder,
      archivedAt: r.archivedAt?.toISOString() ?? null,
      memberCount: r._count.memberships,
      createdAt: r.createdAt.toISOString(),
      ...(at ? { uploadedAt: at } : {}),
      folderName: r.folder?.name ?? null,
    }
  })
}

const strip = ({ folderName: _folderName, ...dto }: ListDTO & { folderName: string | null }): ListDTO => dto

export async function getListDTO(db: Tx | PrismaClient, organizationId: string, id: string): Promise<ListDTO & { folderName: string | null }> {
  const row = await db.callList.findFirst({ where: { id, organizationId }, select: LIST_SELECT })
  if (!row) throw notFound('List')
  return (await toDTOs(db, organizationId, [row]))[0]
}

/** Active lists (or, with archived: true, archived ones), in sidebar order. */
export async function listLists(organizationId: string, opts: { archived?: boolean }, db: PrismaClient = prisma): Promise<ListDTO[]> {
  const rows = await db.callList.findMany({
    where: { organizationId, archivedAt: opts.archived ? { not: null } : null },
    select: LIST_SELECT,
  })
  return (await toDTOs(db, organizationId, rows.sort(sidebarListOrder))).map(strip)
}

export interface CreateListInput {
  name: unknown
  /** null or missing: outside any folder. */
  folderId?: string | null
  /** "Add to list → new list": create it with these people in one step. */
  leadIds?: string[]
}

export async function createList(
  organizationId: string,
  input: CreateListInput,
  db: PrismaClient = prisma,
): Promise<{ list: ListDTO; added: number; notFound: number }> {
  const name = validName(input.name)
  const folderId = input.folderId ?? null
  const leadIds = uniqueIds(input.leadIds ?? [])
  return db.$transaction(async (tx) => {
    await lockScope(tx, organizationId, listScope(folderId))
    await assertFolder(tx, organizationId, folderId)
    await assertListName(tx, organizationId, folderId, name, null)
    const list = await tx.callList.create({
      data: { organizationId, name, folderId, source: 'manual', sortOrder: await nextSortOrder(tx, organizationId, folderId) },
    })
    const counts = leadIds.length
      ? await insertListMembers(tx, organizationId, list.id, leadIds, 'bulk')
      : { added: 0, alreadyIn: 0, notFound: 0 }
    return { list: strip(await getListDTO(tx, organizationId, list.id)), added: counts.added, notFound: counts.notFound }
  }, TX)
}

export interface UpdateListInput {
  name?: unknown
  /** Move it: a folder id, or null for outside folders. It goes last there. */
  folderId?: string | null
  archived?: boolean
}

export async function updateList(organizationId: string, id: string, input: UpdateListInput, db: PrismaClient = prisma): Promise<ListDTO> {
  const newName = input.name === undefined ? undefined : validName(input.name)
  return db.$transaction(async (tx) => {
    const list = await tx.callList.findFirst({ where: { id, organizationId }, select: { id: true, name: true, folderId: true, archivedAt: true } })
    if (!list) throw notFound('List')
    const target = input.folderId === undefined ? list.folderId : input.folderId
    const moving = target !== list.folderId
    const unarchiving = input.archived === false && list.archivedAt !== null
    await lockScope(tx, organizationId, listScope(target))
    if (moving) await assertFolder(tx, organizationId, target)
    const name = newName ?? list.name
    if (moving || name !== list.name) await assertListName(tx, organizationId, target, name, id)

    const data: Prisma.CallListUncheckedUpdateInput = {}
    if (name !== list.name) data.name = name
    if (moving) data.folderId = target
    // Moving into a folder, or back out of the archive, puts it last there.
    if (moving || unarchiving) data.sortOrder = await nextSortOrder(tx, organizationId, target)
    if (input.archived === true && list.archivedAt === null) data.archivedAt = new Date()
    if (unarchiving) data.archivedAt = null
    if (Object.keys(data).length > 0) await tx.callList.update({ where: { id }, data })
    return strip(await getListDTO(tx, organizationId, id))
  }, TX)
}

export async function deleteList(organizationId: string, id: string, db: PrismaClient = prisma): Promise<{ deleted: true; membershipsRemoved: number }> {
  return db.$transaction(async (tx) => {
    const list = await tx.callList.findFirst({ where: { id, organizationId }, select: { id: true } })
    if (!list) throw notFound('List')
    const membershipsRemoved = await tx.listMembership.count({ where: { listId: id } })
    // Cascades to ListMembership only; an import that filled it keeps its row
    // (targetListId is set to NULL). Leads are never touched.
    await tx.callList.delete({ where: { id } })
    return { deleted: true as const, membershipsRemoved }
  }, TX)
}

/** `ids` = the active lists of that scope (a folder, or null = outside folders), in the new order. */
export async function reorderLists(
  organizationId: string,
  input: { folderId: string | null; ids: string[] },
  db: PrismaClient = prisma,
): Promise<{ ok: true }> {
  return db.$transaction(async (tx) => {
    await lockScope(tx, organizationId, listScope(input.folderId))
    await assertFolder(tx, organizationId, input.folderId)
    const current = await tx.callList.findMany({
      where: { organizationId, folderId: input.folderId, archivedAt: null },
      select: { id: true },
    })
    if (!sameSet(current.map((l) => l.id), input.ids)) throw STALE_ORDER
    await tx.$executeRaw`
      UPDATE "CallList" cl SET "sortOrder" = (o.ord - 1)::int, "updatedAt" = ${utc(new Date())}
      FROM unnest(${input.ids}::text[]) WITH ORDINALITY AS o(id, ord)
      WHERE cl.id = o.id AND cl."organizationId" = ${organizationId}`
    return { ok: true as const }
  }, TX)
}
