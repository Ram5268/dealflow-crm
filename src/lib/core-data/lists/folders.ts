// Brief 45 — folders. A folder holds lists only, never another folder
// [Ryan, 2026-10-18], and groups don't go in folders [brief §5.1]. There is no
// parent column, so
// nesting is impossible by construction. A folder is deleted only when it has
// no lists at all, archived ones included [brief §5.1; CONTRACT §2].
import type { PrismaClient } from '@prisma/client'
import { prisma } from '@/lib/prisma'
import type { FolderDTO } from './types'
import {
  FOLDER_SCOPE, STALE_ORDER, TX, conflict, findClash, listScope, lockScope, notFound, sameSet, utc, validName, type Tx,
} from './sql'

const folderClash = (name: string) => conflict(`A folder named "${name}" already exists.`)

async function assertFolderName(tx: Tx, organizationId: string, name: string, selfId: string | null): Promise<void> {
  const rows = await tx.folder.findMany({ where: { organizationId }, select: { id: true, name: true } })
  const clash = findClash(rows, name, selfId)
  if (clash) throw folderClash(clash.name)
}

async function toDTO(db: Tx | PrismaClient, id: string): Promise<FolderDTO> {
  const f = await db.folder.findUniqueOrThrow({
    where: { id },
    select: { id: true, name: true, sortOrder: true, lists: { select: { archivedAt: true } } },
  })
  return {
    id: f.id, name: f.name, sortOrder: f.sortOrder,
    listCount: f.lists.length, archivedListCount: f.lists.filter((l) => l.archivedAt !== null).length,
  }
}

export async function listFolders(organizationId: string, db: PrismaClient = prisma): Promise<FolderDTO[]> {
  const rows = await db.folder.findMany({
    where: { organizationId },
    orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }, { id: 'asc' }],
    select: { id: true, name: true, sortOrder: true, lists: { select: { archivedAt: true } } },
  })
  return rows.map((f) => ({
    id: f.id, name: f.name, sortOrder: f.sortOrder,
    listCount: f.lists.length, archivedListCount: f.lists.filter((l) => l.archivedAt !== null).length,
  }))
}

export async function createFolder(organizationId: string, input: { name: unknown }, db: PrismaClient = prisma): Promise<FolderDTO> {
  const name = validName(input.name)
  return db.$transaction(async (tx) => {
    await lockScope(tx, organizationId, FOLDER_SCOPE)
    await assertFolderName(tx, organizationId, name, null)
    const last = await tx.folder.aggregate({ where: { organizationId }, _max: { sortOrder: true } })
    const folder = await tx.folder.create({ data: { organizationId, name, sortOrder: (last._max.sortOrder ?? -1) + 1 } })
    return { id: folder.id, name: folder.name, sortOrder: folder.sortOrder, listCount: 0, archivedListCount: 0 }
  }, TX)
}

export async function renameFolder(organizationId: string, id: string, input: { name: unknown }, db: PrismaClient = prisma): Promise<FolderDTO> {
  const name = validName(input.name)
  return db.$transaction(async (tx) => {
    await lockScope(tx, organizationId, FOLDER_SCOPE)
    const folder = await tx.folder.findFirst({ where: { id, organizationId }, select: { id: true, name: true } })
    if (!folder) throw notFound('Folder')
    await assertFolderName(tx, organizationId, name, id)
    if (folder.name !== name) await tx.folder.update({ where: { id }, data: { name } })
    return toDTO(tx, id)
  }, TX)
}

export async function deleteFolder(organizationId: string, id: string, db: PrismaClient = prisma): Promise<{ deleted: true }> {
  return db.$transaction(async (tx) => {
    // Moving or creating a list in this folder takes the same lock, so no list
    // can slip in between the count and the delete.
    await lockScope(tx, organizationId, listScope(id))
    const folder = await tx.folder.findFirst({ where: { id, organizationId }, select: { id: true } })
    if (!folder) throw notFound('Folder')
    const lists = await tx.callList.findMany({ where: { folderId: id }, select: { archivedAt: true } })
    if (lists.length > 0) {
      const n = lists.length
      const archived = lists.filter((l) => l.archivedAt !== null).length
      throw conflict(
        `This folder still has ${n} ${n === 1 ? 'list' : 'lists'}${archived ? ` (${archived} archived)` : ''}. ` +
          `Move or delete ${n === 1 ? 'it' : 'them'} first.`,
      )
    }
    await tx.folder.delete({ where: { id } })
    return { deleted: true as const }
  }, TX)
}

/** `ids` = every folder of the org, in the new order. */
export async function reorderFolders(organizationId: string, ids: string[], db: PrismaClient = prisma): Promise<{ ok: true }> {
  return db.$transaction(async (tx) => {
    await lockScope(tx, organizationId, FOLDER_SCOPE)
    const current = await tx.folder.findMany({ where: { organizationId }, select: { id: true } })
    if (!sameSet(current.map((f) => f.id), ids)) throw STALE_ORDER
    await tx.$executeRaw`
      UPDATE "Folder" f SET "sortOrder" = (o.ord - 1)::int, "updatedAt" = ${utc(new Date())}
      FROM unnest(${ids}::text[]) WITH ORDINALITY AS o(id, ord)
      WHERE f.id = o.id AND f."organizationId" = ${organizationId}`
    return { ok: true as const }
  }, TX)
}
