// Brief 45 — the sidebar's model, pure and browser-safe.
//
// buildTree: folders in their order, each holding its lists; the lists outside
// any folder after them; then the groups. Folders hold lists only, no folder
// sits inside another, and a list may sit outside any folder
// [Ryan, 2026-10-18].
//
// planMove: every drag and every keyboard alternative ("Move up", "Move down",
// "Move to folder…") goes through one reducer. It returns the API calls to
// make, in order, and the sidebar as it will look afterwards (shown at once,
// rolled back if a call fails), or null when there is nothing to do. It never
// changes its input.
import type { FolderDTO, GroupDTO, ListDTO, SidebarData } from '@/lib/core-data/lists/types'

export interface FolderNode {
  folder: FolderDTO
  /** Its active lists, in order. */
  lists: ListDTO[]
}

export interface SidebarTreeModel {
  folders: FolderNode[]
  /** Active lists outside any folder, in order. */
  rootLists: ListDTO[]
  groups: GroupDTO[]
}

export function buildTree(data: Pick<SidebarData, 'folders' | 'lists' | 'groups'>): SidebarTreeModel {
  const known = new Set(data.folders.map((f) => f.id))
  return {
    folders: data.folders.map((folder) => ({ folder, lists: data.lists.filter((l) => l.folderId === folder.id) })),
    // A list whose folder isn't in the data still shows (outside folders) rather than vanishing.
    rootLists: data.lists.filter((l) => l.folderId === null || !known.has(l.folderId)),
    groups: data.groups,
  }
}

export type Position = 'before' | 'after'
export type Direction = 'up' | 'down'

export type MoveAction =
  | { type: 'dropListOnFolder'; listId: string; folderId: string }
  | { type: 'dropListOnList'; listId: string; targetId: string; position: Position }
  /** Dropped on the "outside folders" area: out of its folder, last there. */
  | { type: 'dropListOutside'; listId: string }
  /** "Move to folder…": a folder id, or null for outside folders. */
  | { type: 'moveListTo'; listId: string; folderId: string | null }
  | { type: 'moveList'; listId: string; direction: Direction }
  | { type: 'dropFolder'; folderId: string; targetId: string; position: Position }
  | { type: 'moveFolder'; folderId: string; direction: Direction }
  | { type: 'dropGroup'; groupId: string; targetId: string; position: Position }
  | { type: 'moveGroup'; groupId: string; direction: Direction }

/** One request to /api/core-data (client.ts has a wrapper for each). */
export type ApiCall =
  | { call: 'updateList'; id: string; patch: { folderId: string | null } }
  /** Every active list of that scope (a folder, or null = outside folders), in the new order. */
  | { call: 'reorderLists'; folderId: string | null; ids: string[] }
  | { call: 'reorderFolders'; ids: string[] }
  | { call: 'reorderGroups'; ids: string[] }

export interface MovePlan {
  calls: ApiCall[]
  /** The sidebar after the calls succeed. */
  next: SidebarData
}

type Scope = string | null

const scopeIds = (data: SidebarData, scope: Scope) => data.lists.filter((l) => l.folderId === scope).map((l) => l.id)
const sameOrder = (a: readonly string[], b: readonly string[]) => a.length === b.length && a.every((id, i) => id === b[i])

/** `ids` with `moving` placed before/after `target`; null when either is missing or nothing moves. */
function placed(ids: readonly string[], moving: string, target: string, position: Position): string[] | null {
  if (moving === target || !ids.includes(moving) || !ids.includes(target)) return null
  const rest = ids.filter((id) => id !== moving)
  const at = rest.indexOf(target) + (position === 'after' ? 1 : 0)
  const next = [...rest.slice(0, at), moving, ...rest.slice(at)]
  return sameOrder(next, ids) ? null : next
}

/** `ids` with `moving` swapped one step up or down; null at either end. */
function stepped(ids: readonly string[], moving: string, direction: Direction): string[] | null {
  const i = ids.indexOf(moving)
  const j = direction === 'up' ? i - 1 : i + 1
  if (i < 0 || j < 0 || j >= ids.length) return null
  const next = [...ids]
  ;[next[i], next[j]] = [next[j], next[i]]
  return next
}

/**
 * The lists in sidebar order (each folder's lists in folder order, then those
 * outside folders), with new per-scope orders and folder ids applied.
 */
function relist(data: SidebarData, folders: FolderDTO[], orders: Map<Scope, string[]> = new Map()): ListDTO[] {
  const byId = new Map(data.lists.map((l) => [l.id, l]))
  const out: ListDTO[] = []
  const take = (scope: Scope) => {
    for (const id of orders.get(scope) ?? scopeIds(data, scope)) {
      const l = byId.get(id)
      if (l) out.push(l.folderId === scope ? l : { ...l, folderId: scope })
    }
  }
  for (const f of folders) take(f.id)
  take(null)
  // Lists of a folder that isn't in the data keep their place at the end.
  const seen = new Set(out.map((l) => l.id))
  for (const l of data.lists) if (!seen.has(l.id)) out.push(l)
  return out
}

/** Move a list into `to` (a folder, or null) at `index` among that scope's other lists (default: last). */
function moveListInto(data: SidebarData, listId: string, to: Scope, index?: number): MovePlan | null {
  const list = data.lists.find((l) => l.id === listId)
  if (!list) return null
  if (to !== null && !data.folders.some((f) => f.id === to)) return null
  const from = list.folderId
  const others = scopeIds(data, to).filter((id) => id !== listId)
  const at = index === undefined ? others.length : Math.max(0, Math.min(index, others.length))
  const order = [...others.slice(0, at), listId, ...others.slice(at)]

  const calls: ApiCall[] = []
  if (from !== to) {
    calls.push({ call: 'updateList', id: listId, patch: { folderId: to } })
    // The PATCH puts it last in its new scope; reorder only when it belongs elsewhere.
    if (at !== others.length) calls.push({ call: 'reorderLists', folderId: to, ids: order })
  } else {
    if (sameOrder(order, scopeIds(data, to))) return null
    calls.push({ call: 'reorderLists', folderId: to, ids: order })
  }

  const orders = new Map<Scope, string[]>([[to, order]])
  if (from !== to) orders.set(from, scopeIds(data, from).filter((id) => id !== listId))
  const folders = data.folders.map((f) => {
    if (from === to) return f
    if (f.id === from) return { ...f, listCount: Math.max(0, f.listCount - 1) }
    if (f.id === to) return { ...f, listCount: f.listCount + 1 }
    return f
  })
  return { calls, next: { ...data, folders, lists: relist(data, folders, orders) } }
}

function reorderFoldersPlan(data: SidebarData, ids: string[] | null): MovePlan | null {
  if (!ids) return null
  const byId = new Map(data.folders.map((f) => [f.id, f]))
  const folders = ids.map((id) => byId.get(id)!)
  return { calls: [{ call: 'reorderFolders', ids }], next: { ...data, folders, lists: relist(data, folders) } }
}

function reorderGroupsPlan(data: SidebarData, ids: string[] | null): MovePlan | null {
  if (!ids) return null
  const byId = new Map(data.groups.map((g) => [g.id, g]))
  return { calls: [{ call: 'reorderGroups', ids }], next: { ...data, groups: ids.map((id) => byId.get(id)!) } }
}

export function planMove(data: SidebarData, action: MoveAction): MovePlan | null {
  const list = 'listId' in action ? data.lists.find((l) => l.id === action.listId) : undefined
  switch (action.type) {
    case 'dropListOnFolder':
      if (!list || list.folderId === action.folderId) return null
      return moveListInto(data, action.listId, action.folderId)
    case 'dropListOutside':
      if (!list || list.folderId === null) return null
      return moveListInto(data, action.listId, null)
    case 'moveListTo':
      if (!list || list.folderId === action.folderId) return null
      return moveListInto(data, action.listId, action.folderId)
    case 'dropListOnList': {
      const target = data.lists.find((l) => l.id === action.targetId)
      if (!list || !target || target.id === list.id) return null
      const others = scopeIds(data, target.folderId).filter((id) => id !== list.id)
      const index = others.indexOf(target.id) + (action.position === 'after' ? 1 : 0)
      return moveListInto(data, list.id, target.folderId, index)
    }
    case 'moveList': {
      if (!list) return null
      const ids = stepped(scopeIds(data, list.folderId), list.id, action.direction)
      return ids ? moveListInto(data, list.id, list.folderId, ids.indexOf(list.id)) : null
    }
    case 'dropFolder':
      return reorderFoldersPlan(data, placed(data.folders.map((f) => f.id), action.folderId, action.targetId, action.position))
    case 'moveFolder':
      return reorderFoldersPlan(data, stepped(data.folders.map((f) => f.id), action.folderId, action.direction))
    case 'dropGroup':
      return reorderGroupsPlan(data, placed(data.groups.map((g) => g.id), action.groupId, action.targetId, action.position))
    case 'moveGroup':
      return reorderGroupsPlan(data, stepped(data.groups.map((g) => g.id), action.groupId, action.direction))
  }
}

/** Whether "Move up" / "Move down" can do anything (for greying out menu items). */
export function canStep(ids: readonly string[], id: string, direction: Direction): boolean {
  return stepped(ids, id, direction) !== null
}

export type DragKind = 'folder' | 'list' | 'group'
export type DropKind = DragKind | 'outside'

/**
 * Where a dragged item may land, for the row under the pointer: a list onto a
 * folder ("into"), onto another list or the "outside folders" area; a folder
 * among folders; a group among groups. `upperHalf` = the pointer is in the
 * row's top half (drop before it). Null = not a place it can go.
 */
export function dropPosition(drag: { kind: DragKind; id: string }, over: { kind: DropKind; id: string }, upperHalf: boolean): Position | 'into' | null {
  if (over.kind === 'outside') return drag.kind === 'list' ? 'into' : null
  if (drag.kind === 'list' && over.kind === 'folder') return 'into'
  if (drag.kind !== over.kind || drag.id === over.id) return null
  return upperHalf ? 'before' : 'after'
}

/** The move a drop makes (then planMove works out the calls), or null. */
export function dropAction(
  drag: { kind: DragKind; id: string },
  target: { kind: DropKind; id: string; position: Position | 'into' },
): MoveAction | null {
  const { position } = target
  if (drag.kind === 'list') {
    if (target.kind === 'folder' && position === 'into') return { type: 'dropListOnFolder', listId: drag.id, folderId: target.id }
    if (target.kind === 'outside') return { type: 'dropListOutside', listId: drag.id }
    if (target.kind === 'list' && position !== 'into') return { type: 'dropListOnList', listId: drag.id, targetId: target.id, position }
    return null
  }
  if (position === 'into' || target.kind !== drag.kind) return null
  return drag.kind === 'folder'
    ? { type: 'dropFolder', folderId: drag.id, targetId: target.id, position }
    : { type: 'dropGroup', groupId: drag.id, targetId: target.id, position }
}
