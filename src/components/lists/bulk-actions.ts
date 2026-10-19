// Brief 45 PR C — bulk actions on a selection of leads [brief §5.4]: Add to
// group · Remove from group · Add to list (an existing list, or a new one) ·
// Remove from this list · Export CSV. Used on All leads (LeadsView), list
// pages and the Pipeline table. Organization only: nothing here calls, texts,
// emails, enrolls or schedules anyone [Ryan, 2026-09-24].
//
// The API takes at most 5,000 people per request [engineering precaution,
// CONTRACT §2], so a bigger selection goes in chunks, one after another, and
// the counts add up. Every request is idempotent (adding someone already in,
// or removing someone who isn't, changes nothing), so a run that stops part
// way can simply be repeated. Results read in plain English.
import {
  addGroupMembers,
  addListMembers,
  createList,
  removeGroupMembers,
  removeListMembers,
} from '@/lib/core-data/lists/client'
import { BULK_MAX, IDS_CAP } from '@/lib/core-data/lists/types'
import { plainError } from './group-chips-state'

export type BulkKind = 'addToGroup' | 'removeFromGroup' | 'addToList' | 'newList' | 'removeFromThisList'

export type BulkOp =
  | { kind: 'addToGroup' | 'removeFromGroup'; groupId: string; name: string }
  | { kind: 'addToList' | 'removeFromThisList'; listId: string; name: string }
  | { kind: 'newList'; name: string; folderId: string | null }

export interface BulkTotals {
  /** Distinct people sent. */
  requested: number
  added: number
  alreadyIn: number
  /** Unknown ids, or another organization's (the API never adds those). */
  notFound: number
  removed: number
}

/** A selection as requests of at most `size` people, in order, each person once. */
export function chunkIds(ids: readonly string[], size: number = BULK_MAX): string[][] {
  const unique = [...new Set(ids)]
  const chunks: string[][] = []
  for (let i = 0; i < unique.length; i += size) chunks.push(unique.slice(i, i + size))
  return chunks
}

const num = (n: number) => n.toLocaleString('en-US')
export const peopleCount = (n: number) => `${num(n)} ${n === 1 ? 'person' : 'people'}`
const were = (n: number) => `${num(n)} ${n === 1 ? 'was' : 'were'}`
const werent = (n: number) => `${num(n)} ${n === 1 ? "wasn't" : "weren't"}`

/** "Added 42 people to Hot · 3 were already in it", and the like. */
export function bulkResultText(kind: BulkKind, t: BulkTotals, name: string): string {
  const notFound = t.notFound > 0 ? ` · ${num(t.notFound)} couldn't be found` : ''
  switch (kind) {
    case 'addToGroup':
    case 'addToList': {
      const where = kind === 'addToGroup' ? 'in' : 'on'
      if (t.added === 0 && t.alreadyIn > 0) {
        const who = t.alreadyIn === 1 ? 'They were' : `All ${num(t.alreadyIn)} were`
        return `${who} already ${where} ${name}${notFound}`
      }
      const already = t.alreadyIn > 0 ? ` · ${were(t.alreadyIn)} already ${where} it` : ''
      return `Added ${peopleCount(t.added)} to ${name}${already}${notFound}`
    }
    case 'newList':
      return `Made the list ${name} with ${peopleCount(t.added)}${notFound}`
    case 'removeFromGroup': {
      if (t.removed === 0) return t.requested === 1 ? `They weren't in ${name}` : `None of the ${num(t.requested)} were in ${name}`
      const missing = t.requested - t.removed
      return `Removed ${peopleCount(t.removed)} from ${name}${missing > 0 ? ` · ${werent(missing)} in it` : ''}`
    }
    case 'removeFromThisList': {
      const missing = t.requested - t.removed
      return `Removed ${peopleCount(t.removed)} from ${name} · they stay in the CRM${missing > 0 ? ` · ${werent(missing)} on it` : ''}`
    }
  }
}

// What a run that stopped part way had already done, then why it stopped.
function partialText(op: BulkOp, t: BulkTotals, message: string): string {
  const done =
    op.kind === 'addToGroup' || op.kind === 'addToList'
      ? `Added ${peopleCount(t.added)} to ${op.name}`
      : op.kind === 'newList'
        ? `Made the list ${op.name} with ${peopleCount(t.added)}`
        : `Removed ${peopleCount(t.removed)} from ${op.name}`
  const retry =
    op.kind === 'addToGroup'
      ? 'Trying again is safe: people already in it are skipped.'
      : op.kind === 'addToList'
        ? 'Trying again is safe: people already on it are skipped.'
        : op.kind === 'newList'
          ? `Add the rest with Add to list → ${op.name}: people already on it are skipped.`
          : 'Trying again is safe.'
  return `${done}, then stopped: ${message} ${retry}`
}

export interface BulkRun {
  totals: BulkTotals
  /** The plain-English result (or what was done, then why it stopped). */
  text: string
  /** Why it stopped, or null when it finished. */
  error: string | null
  /** The list it added to or made, when there is one. */
  listId: string | null
}

export const NOBODY_SELECTED = 'Select at least one person first.'

/**
 * Runs a bulk action over a selection, 5,000 people per request, one request
 * after another. A new list is made with the first chunk, and the rest are
 * added to it. Stops at the first refusal and says what was done. An empty
 * selection is refused before anything is sent (nothing is made or changed).
 */
export async function runBulk(op: BulkOp, leadIds: readonly string[], onProgress?: (done: number, total: number) => void): Promise<BulkRun> {
  const chunks = chunkIds(leadIds)
  const totals: BulkTotals = { requested: chunks.reduce((n, c) => n + c.length, 0), added: 0, alreadyIn: 0, notFound: 0, removed: 0 }
  if (chunks.length === 0) return { totals, text: NOBODY_SELECTED, error: NOBODY_SELECTED, listId: null }
  let listId: string | null = op.kind === 'addToList' || op.kind === 'removeFromThisList' ? op.listId : null
  let done = 0
  const add = (r: { added: number; alreadyIn?: number; notFound: number }) => {
    totals.added += r.added
    totals.alreadyIn += r.alreadyIn ?? 0
    totals.notFound += r.notFound
  }
  try {
    for (const chunk of chunks) {
      switch (op.kind) {
        case 'addToGroup':
          add(await addGroupMembers(op.groupId, chunk))
          break
        case 'removeFromGroup':
          totals.removed += (await removeGroupMembers(op.groupId, chunk)).removed
          break
        case 'addToList':
          add(await addListMembers(op.listId, chunk))
          break
        case 'removeFromThisList':
          totals.removed += (await removeListMembers(op.listId, chunk)).removed
          break
        case 'newList':
          if (listId === null) {
            // Made with the first chunk ("Add to list → new list"); the rest are added to it.
            const made = await createList({ name: op.name, folderId: op.folderId, leadIds: chunk })
            listId = made.list.id
            add(made)
          } else add(await addListMembers(listId, chunk))
          break
      }
      done += chunk.length
      onProgress?.(done, totals.requested)
    }
  } catch (err) {
    const { message } = plainError(err)
    return { totals, text: done > 0 ? partialText(op, totals, message) : message, error: message, listId }
  }
  return { totals, text: bulkResultText(op.kind, totals, op.name), error: null, listId }
}

// ─── The menu ────────────────────────────────────────────────────────────────

export type BulkEntry = 'addToGroup' | 'removeFromGroup' | 'addToList' | 'removeFromThisList' | 'export'

/** The menu's entries: "Remove from this list" only on a list; Export when the page can export. */
export function bulkMenuEntries(opts: { listId?: string; canExport?: boolean }): BulkEntry[] {
  return [
    'addToGroup',
    'removeFromGroup',
    'addToList',
    ...(opts.listId ? (['removeFromThisList'] as const) : []),
    ...(opts.canExport ? (['export'] as const) : []),
  ]
}

// ─── "Select all N matching" ─────────────────────────────────────────────────

export type SelectAllState =
  | { kind: 'none' }
  /** The whole page is selected and more people match: offer the rest. */
  | { kind: 'offer'; pageCount: number; total: number }
  /** Everyone matching is selected (at most 25,000 at once: the API's `ids=1` cap). */
  | { kind: 'all'; count: number; capped: boolean }

export function selectAllOffer(input: { pageIds: readonly string[]; selected: ReadonlySet<string>; total: number; cap?: number }): SelectAllState {
  const { pageIds, selected, total, cap = IDS_CAP } = input
  if (pageIds.length === 0) return { kind: 'none' }
  if (selected.size > pageIds.length && selected.size >= Math.min(total, cap)) {
    return { kind: 'all', count: selected.size, capped: selected.size < total }
  }
  if (total > selected.size && pageIds.every((id) => selected.has(id))) {
    return { kind: 'offer', pageCount: pageIds.length, total }
  }
  return { kind: 'none' }
}
