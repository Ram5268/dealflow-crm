// Brief 45 (PR F): where an upload's people go [brief §5.7]. The first step of
// an upload asks "Where should these people go?": an existing list, or a new
// list (a name, and a folder or no folder [Ryan, 2026-10-18: "a list can sit
// outside a folder"]). The choice is kept as ImportBatch.targetListId; the
// commit puts every row's lead on that list.
//
// A new list is made by the lists API's own createList (PR A), so its name
// follows exactly the same rules and gets exactly the same plain-English
// refusal ("A list named "X" is already in this folder."). It is created in
// the same transaction as the import, with source 'upload:<importId>': a
// refused name creates nothing, and nothing is stored before the check passes.
import type { PrismaClient } from '@prisma/client'
import { prisma } from '@/lib/prisma'
import { HttpError } from '@/lib/shared/http'
import { createList } from '@/lib/core-data/lists/lists'
import { TX, conflict, notFound, type Tx } from '@/lib/core-data/lists/sql'

export type ImportDestination =
  | { kind: 'list'; listId: string }
  /** folderId null: the list sits outside any folder. */
  | { kind: 'new'; name: string; folderId: string | null }

export const DESTINATION_MISSING = 'Choose where these people should go: an existing list, or a new list.'
export const LIST_ARCHIVED = 'That list is archived. Unarchive it first, or pick another list.'

export interface TargetList {
  id: string
  name: string
  /** true when this upload made the list. */
  created: boolean
}

const text = (v: unknown) => (typeof v === 'string' ? v : '')

/** The upload's fields (multipart or JSON) → one destination, or a 400. */
export function parseDestination(input: { listId?: unknown; newListName?: unknown; newListFolderId?: unknown }): ImportDestination {
  const listId = text(input.listId).trim()
  const name = text(input.newListName)
  // Exactly one: an existing list, or a new list's name (checked by createList).
  if ((listId !== '') === (name !== '')) throw new HttpError(400, DESTINATION_MISSING, { field: 'destination' })
  if (listId) return { kind: 'list', listId }
  return { kind: 'new', name, folderId: text(input.newListFolderId).trim() || null }
}

// PR A's createList opens its own transaction. This hands it ours instead, so
// the import, its new list and the link between them commit together or not
// at all (and the name check's scope lock is held until then).
function insideTransaction(tx: Tx): PrismaClient {
  return new Proxy(tx, {
    get(target, prop) {
      if (prop === '$transaction') return (fn: (t: Tx) => unknown) => fn(target)
      const value = Reflect.get(target, prop)
      return typeof value === 'function' ? value.bind(target) : value
    },
  }) as unknown as PrismaClient
}

// A refusal about the destination says so, so the page shows it at that step.
async function forDestination<T>(work: () => Promise<T>): Promise<T> {
  try {
    return await work()
  } catch (err) {
    if (err instanceof HttpError) throw new HttpError(err.status, err.message, { ...err.extra, field: 'destination' })
    throw err
  }
}

/** Checks the destination and, for a new list, creates it (inside the caller's transaction). */
export async function applyDestination(tx: Tx, organizationId: string, importId: string, dest: ImportDestination): Promise<TargetList> {
  return forDestination(async () => {
    if (dest.kind === 'list') {
      const list = await tx.callList.findFirst({ where: { id: dest.listId, organizationId }, select: { id: true, name: true, archivedAt: true } })
      if (!list) throw notFound('List')
      // The picker leaves archived lists out; one archived since the page loaded is refused.
      if (list.archivedAt) throw conflict(LIST_ARCHIVED)
      return { id: list.id, name: list.name, created: false }
    }
    const { list } = await createList(organizationId, { name: dest.name, folderId: dest.folderId }, insideTransaction(tx))
    await tx.callList.update({ where: { id: list.id }, data: { source: `upload:${importId}` } })
    return { id: list.id, name: list.name, created: true }
  })
}

export interface NewUpload {
  organizationId: string
  userId: string
  sourceLabel: string
  filename: string
}

/** The import (pending, file not stored yet) and its list, in one transaction. */
export async function createImportBatch(
  upload: NewUpload,
  dest: ImportDestination,
  db: PrismaClient = prisma,
): Promise<{ batchId: string; list: TargetList }> {
  return db.$transaction(async (tx) => {
    const batch = await tx.importBatch.create({ data: { ...upload, storageKey: 'pending', status: 'pending' } })
    const list = await applyDestination(tx, upload.organizationId, batch.id, dest)
    await tx.importBatch.update({ where: { id: batch.id }, data: { targetListId: list.id } })
    return { batchId: batch.id, list }
  }, TX)
}

class DryRun {
  constructor(readonly name: string) {}
}

/**
 * The same checks as createImportBatch, writing nothing: the page asks before
 * the file is sent, so a name that is taken is refused before any upload. A
 * new list is created and rolled back, so the answer is exactly the upload's.
 */
export async function checkDestination(organizationId: string, dest: ImportDestination, db: PrismaClient = prisma): Promise<{ name: string }> {
  const outcome = await db
    .$transaction(async (tx) => {
      throw new DryRun((await applyDestination(tx, organizationId, 'check', dest)).name)
    }, TX)
    .then(
      () => null,
      (err: unknown) => err,
    )
  if (outcome instanceof DryRun) return { name: outcome.name }
  throw outcome
}

/**
 * An upload whose file couldn't be stored: remove the import, and the list it
 * made if that list is still empty, so the name can be used again. A list that
 * existed before the upload is never touched.
 */
export async function discardImportBatch(organizationId: string, batchId: string, list: TargetList, db: PrismaClient = prisma): Promise<void> {
  await db.$transaction([
    db.importBatch.deleteMany({ where: { id: batchId, organizationId } }),
    ...(list.created
      ? [db.callList.deleteMany({ where: { id: list.id, organizationId, source: `upload:${batchId}`, memberships: { none: {} } } })]
      : []),
  ])
}
