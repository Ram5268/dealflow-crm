import { describe, it, expect } from 'vitest'
import type { FolderDTO, GroupDTO, ListDTO, SidebarData } from '@/lib/core-data/lists/types'
import { buildTree, planMove, type MoveAction } from '@/components/lists/sidebar/tree'

// Brief 45 PR B — the sidebar's drag-and-drop and its keyboard alternatives
// ("Move up / Move down / Move to folder…") as one pure reducer: an action in,
// the API calls to make and the new sidebar order out (the optimistic view).
// Folders hold lists only, and a list may sit outside any folder
// [Ryan, 2026-10-18]. Made-up names only.

const folder = (id: string, name: string, sortOrder: number, listCount: number): FolderDTO => ({
  id, name, sortOrder, listCount, archivedListCount: 0,
})
const list = (id: string, name: string, folderId: string | null, sortOrder: number, memberCount = 10): ListDTO => ({
  id, name, folderId, source: 'manual', sortOrder, archivedAt: null, memberCount, createdAt: '2026-10-01T12:00:00.000Z',
})
const group = (id: string, name: string, sortOrder: number): GroupDTO => ({
  id, name, color: 'gray', sortOrder, memberCount: 3,
})

function fixture(): SidebarData {
  return {
    allLeads: { count: 1489, rankedAt: '2026-10-18T11:02:00.000Z' },
    folders: [folder('f1', 'Expireds', 0, 2), folder('f2', 'Off-market', 1, 1), folder('f3', 'Empty folder', 2, 0)],
    // Sidebar order: the lists of each folder in folder order, then lists outside folders.
    lists: [
      list('l1', 'Expireds – Oct 2026', 'f1', 0, 412),
      list('l2', 'Expireds – Sep 2026', 'f1', 1),
      list('l3', 'Brownstones likely to sell', 'f2', 0, 1102),
      list('l4', 'Referrals', null, 0, 41),
      list('l5', 'Past clients', null, 1),
    ],
    archivedCount: 0,
    groups: [group('g1', 'Hot', 0), group('g2', 'Appointment Set', 1), group('g3', 'Nurture', 2)],
    workflows: [],
  }
}

const ids = <T extends { id: string }>(xs: T[]) => xs.map((x) => x.id)
const scope = (d: SidebarData, folderId: string | null) => ids(d.lists.filter((l) => l.folderId === folderId))
const plan = (action: MoveAction) => planMove(fixture(), action)

describe('buildTree', () => {
  it('puts each folder with its lists in order, then the lists outside folders, then the groups', () => {
    const t = buildTree(fixture())
    expect(t.folders.map((f) => [f.folder.id, ids(f.lists)])).toEqual([
      ['f1', ['l1', 'l2']],
      ['f2', ['l3']],
      ['f3', []],
    ])
    expect(ids(t.rootLists)).toEqual(['l4', 'l5'])
    expect(ids(t.groups)).toEqual(['g1', 'g2', 'g3'])
  })

  it('a list whose folder is missing from the data still shows (outside folders), never lost', () => {
    const d = fixture()
    d.lists.push(list('l9', 'Orphan', 'gone', 0))
    expect(ids(buildTree(d).rootLists)).toContain('l9')
  })
})

describe('dragging a list', () => {
  it('onto a folder: one PATCH, and it goes last in that folder', () => {
    const p = plan({ type: 'dropListOnFolder', listId: 'l4', folderId: 'f1' })!
    expect(p.calls).toEqual([{ call: 'updateList', id: 'l4', patch: { folderId: 'f1' } }])
    expect(scope(p.next, 'f1')).toEqual(['l1', 'l2', 'l4'])
    expect(scope(p.next, null)).toEqual(['l5'])
    expect(p.next.lists.find((l) => l.id === 'l4')!.folderId).toBe('f1')
    // The folder counts move with it (a folder can be deleted only when empty).
    expect(p.next.folders.find((f) => f.id === 'f1')!.listCount).toBe(3)
  })

  it('onto an empty folder, and out of its old folder (counts on both sides)', () => {
    const p = plan({ type: 'dropListOnFolder', listId: 'l3', folderId: 'f3' })!
    expect(p.calls).toEqual([{ call: 'updateList', id: 'l3', patch: { folderId: 'f3' } }])
    expect(p.next.folders.map((f) => [f.id, f.listCount])).toEqual([['f1', 2], ['f2', 0], ['f3', 1]])
  })

  it('onto its own folder: nothing to do', () => {
    expect(plan({ type: 'dropListOnFolder', listId: 'l1', folderId: 'f1' })).toBeNull()
  })

  it('before a list in another folder: move it there, then put the folder in the new order', () => {
    const p = plan({ type: 'dropListOnList', listId: 'l4', targetId: 'l2', position: 'before' })!
    expect(p.calls).toEqual([
      { call: 'updateList', id: 'l4', patch: { folderId: 'f1' } },
      { call: 'reorderLists', folderId: 'f1', ids: ['l1', 'l4', 'l2'] },
    ])
    expect(scope(p.next, 'f1')).toEqual(['l1', 'l4', 'l2'])
  })

  it('after the last list of another folder: the move alone puts it there (no reorder call)', () => {
    const p = plan({ type: 'dropListOnList', listId: 'l4', targetId: 'l2', position: 'after' })!
    expect(p.calls).toEqual([{ call: 'updateList', id: 'l4', patch: { folderId: 'f1' } }])
    expect(scope(p.next, 'f1')).toEqual(['l1', 'l2', 'l4'])
  })

  it('within its own folder: one reorder call with every list of that folder', () => {
    const p = plan({ type: 'dropListOnList', listId: 'l1', targetId: 'l2', position: 'after' })!
    expect(p.calls).toEqual([{ call: 'reorderLists', folderId: 'f1', ids: ['l2', 'l1'] }])
    expect(scope(p.next, 'f1')).toEqual(['l2', 'l1'])
  })

  it('among the lists outside folders', () => {
    const p = plan({ type: 'dropListOnList', listId: 'l5', targetId: 'l4', position: 'before' })!
    expect(p.calls).toEqual([{ call: 'reorderLists', folderId: null, ids: ['l5', 'l4'] }])
  })

  it('from a folder onto a list outside folders: out of the folder, into that spot', () => {
    const p = plan({ type: 'dropListOnList', listId: 'l1', targetId: 'l4', position: 'before' })!
    expect(p.calls).toEqual([
      { call: 'updateList', id: 'l1', patch: { folderId: null } },
      { call: 'reorderLists', folderId: null, ids: ['l1', 'l4', 'l5'] },
    ])
    expect(scope(p.next, 'f1')).toEqual(['l2'])
    expect(p.next.folders.find((f) => f.id === 'f1')!.listCount).toBe(1)
  })

  it('to where it already is, or onto itself: nothing to do', () => {
    expect(plan({ type: 'dropListOnList', listId: 'l1', targetId: 'l2', position: 'before' })).toBeNull()
    expect(plan({ type: 'dropListOnList', listId: 'l2', targetId: 'l1', position: 'after' })).toBeNull()
    expect(plan({ type: 'dropListOnList', listId: 'l1', targetId: 'l1', position: 'after' })).toBeNull()
  })

  it('onto the "outside folders" area: out of its folder, last among the lists outside folders', () => {
    const p = plan({ type: 'dropListOutside', listId: 'l3' })!
    expect(p.calls).toEqual([{ call: 'updateList', id: 'l3', patch: { folderId: null } }])
    expect(scope(p.next, null)).toEqual(['l4', 'l5', 'l3'])
    expect(plan({ type: 'dropListOutside', listId: 'l4' })).toBeNull()
  })

  it('unknown lists, folders or targets do nothing', () => {
    expect(plan({ type: 'dropListOnFolder', listId: 'nope', folderId: 'f1' })).toBeNull()
    expect(plan({ type: 'dropListOnFolder', listId: 'l1', folderId: 'nope' })).toBeNull()
    expect(plan({ type: 'dropListOnList', listId: 'l1', targetId: 'nope', position: 'before' })).toBeNull()
  })
})

describe('keyboard alternatives for a list: Move up / Move down / Move to folder…', () => {
  it('Move up and Move down stay within the list’s folder (or among lists outside folders)', () => {
    expect(plan({ type: 'moveList', listId: 'l2', direction: 'up' })!.calls).toEqual([
      { call: 'reorderLists', folderId: 'f1', ids: ['l2', 'l1'] },
    ])
    expect(plan({ type: 'moveList', listId: 'l4', direction: 'down' })!.calls).toEqual([
      { call: 'reorderLists', folderId: null, ids: ['l5', 'l4'] },
    ])
  })

  it('at the top or bottom there is nothing to do', () => {
    expect(plan({ type: 'moveList', listId: 'l1', direction: 'up' })).toBeNull()
    expect(plan({ type: 'moveList', listId: 'l2', direction: 'down' })).toBeNull()
    expect(plan({ type: 'moveList', listId: 'l3', direction: 'up' })).toBeNull()
    expect(plan({ type: 'moveList', listId: 'l5', direction: 'down' })).toBeNull()
  })

  it('Move to folder… moves it (last there), or out of folders with null', () => {
    expect(plan({ type: 'moveListTo', listId: 'l5', folderId: 'f2' })!.calls).toEqual([
      { call: 'updateList', id: 'l5', patch: { folderId: 'f2' } },
    ])
    const out = plan({ type: 'moveListTo', listId: 'l1', folderId: null })!
    expect(out.calls).toEqual([{ call: 'updateList', id: 'l1', patch: { folderId: null } }])
    expect(scope(out.next, null)).toEqual(['l4', 'l5', 'l1'])
    expect(plan({ type: 'moveListTo', listId: 'l1', folderId: 'f1' })).toBeNull()
  })
})

describe('folders and groups reorder (drag or keyboard)', () => {
  it('dragging a folder sends every folder in the new order', () => {
    const p = plan({ type: 'dropFolder', folderId: 'f3', targetId: 'f1', position: 'before' })!
    expect(p.calls).toEqual([{ call: 'reorderFolders', ids: ['f3', 'f1', 'f2'] }])
    expect(ids(p.next.folders)).toEqual(['f3', 'f1', 'f2'])
    // The lists follow their folder in the sidebar order.
    expect(ids(p.next.lists)).toEqual(['l1', 'l2', 'l3', 'l4', 'l5'])
  })

  it('a folder dragged after the next folder moves its lists with it', () => {
    const p = plan({ type: 'dropFolder', folderId: 'f1', targetId: 'f2', position: 'after' })!
    expect(p.calls).toEqual([{ call: 'reorderFolders', ids: ['f2', 'f1', 'f3'] }])
    expect(ids(p.next.lists)).toEqual(['l3', 'l1', 'l2', 'l4', 'l5'])
  })

  it('Move up / Move down on folders and groups', () => {
    expect(plan({ type: 'moveFolder', folderId: 'f2', direction: 'up' })!.calls).toEqual([
      { call: 'reorderFolders', ids: ['f2', 'f1', 'f3'] },
    ])
    expect(plan({ type: 'moveFolder', folderId: 'f1', direction: 'up' })).toBeNull()
    expect(plan({ type: 'moveGroup', groupId: 'g3', direction: 'up' })!.calls).toEqual([
      { call: 'reorderGroups', ids: ['g1', 'g3', 'g2'] },
    ])
    expect(plan({ type: 'moveGroup', groupId: 'g3', direction: 'down' })).toBeNull()
  })

  it('dragging a group sends every group in the new order', () => {
    const p = plan({ type: 'dropGroup', groupId: 'g1', targetId: 'g3', position: 'after' })!
    expect(p.calls).toEqual([{ call: 'reorderGroups', ids: ['g2', 'g3', 'g1'] }])
    expect(ids(p.next.groups)).toEqual(['g2', 'g3', 'g1'])
    expect(plan({ type: 'dropGroup', groupId: 'g1', targetId: 'g2', position: 'before' })).toBeNull()
  })

  it('never changes the input (the old order stays available for a rollback)', () => {
    const d = fixture()
    const before = JSON.stringify(d)
    planMove(d, { type: 'dropListOnList', listId: 'l4', targetId: 'l2', position: 'before' })
    planMove(d, { type: 'dropFolder', folderId: 'f3', targetId: 'f1', position: 'before' })
    expect(JSON.stringify(d)).toBe(before)
  })
})
