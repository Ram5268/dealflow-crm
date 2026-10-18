'use client'

// Brief 45 — the Mojo-style sidebar, live (brief §5.2). Reads the shared
// sidebar store (useSidebarData: one /sidebar request for every sidebar, chip
// row and count on the page; it reloads on crm:lists-changed) and turns each
// click, key and drag into PR A's /api/core-data calls:
//  - create inline: type a name, Enter (Esc cancels); the API's refusal shows
//    under the box word for word;
//  - rename: double-click or F2;
//  - drag a list into or out of a folder, drag to reorder lists, folders and
//    groups; every drag has a keyboard twin (Move up / Move down / Move to
//    folder…, ⌥↑ / ⌥↓), all through planMove, shown at once and rolled back
//    if the server says no;
//  - right-click (or ⋯, Shift+F10, the menu key) for each item's menu.
// Ryan creates every folder, list and group himself [Ryan, 2026-10-18].
// Deleting a list or a group never deletes a person [brief §5.1]. Nothing
// here contacts anyone.
import { useCallback, useEffect, useRef, useState } from 'react'
import { usePathname, useRouter, useSearchParams } from 'next/navigation'
import { useToast } from '@/components/ui'
import {
  LISTS_CHANGED_EVENT, createFolder, createGroup, createList, deleteFolder, deleteGroup, deleteList, getLists,
  listExportUrl, notifyListsChanged, renameFolder, reorderFolders, reorderGroups, reorderLists, updateGroup, updateList,
  useSidebarData,
} from '@/lib/core-data/lists/client'
import { nameProblem, normalizeName } from '@/lib/core-data/lists/rules'
import type { ListDTO, SidebarData } from '@/lib/core-data/lists/types'
import { peopleCount } from '../format'
import { downloadUrl, messageOf } from '../browser'
import { SidebarTree, SidebarUiContext, menuKey, type DropTarget, type ItemRef, type MenuAction, type SidebarUi } from './SidebarTree'
import { dropAction, dropPosition, planMove, type ApiCall, type MoveAction } from './tree'
import { useSidebarPrefs } from './prefs'
import { ConfirmDialog } from './ConfirmDialog'
import type { CreateKind, CreateRequest } from './createRequest'

const CREATE_LABEL: Record<CreateKind, string> = { folder: 'New folder', list: 'New list', group: 'New group' }

function callApi(c: ApiCall): Promise<unknown> {
  switch (c.call) {
    case 'updateList':
      return updateList(c.id, c.patch)
    case 'reorderLists':
      return reorderLists(c.folderId, c.ids)
    case 'reorderFolders':
      return reorderFolders(c.ids)
    case 'reorderGroups':
      return reorderGroups(c.ids)
  }
}

/** The clock for "ranked 7:02 / Oct 17", ticking once a minute. */
function useNow(): Date {
  const [now, setNow] = useState(() => new Date())
  useEffect(() => {
    const id = setInterval(() => setNow(new Date()), 60_000)
    return () => clearInterval(id)
  }, [])
  return now
}

/** The archived lists, loaded only while the Archived section is open. */
function useArchivedLists(open: boolean): { lists: ListDTO[] | null; error: string | null } {
  const [state, setState] = useState<{ lists: ListDTO[] | null; error: string | null }>({ lists: null, error: null })
  useEffect(() => {
    if (!open) return
    let cancelled = false
    const load = () =>
      getLists({ archived: true }).then(
        (lists) => !cancelled && setState({ lists, error: null }),
        (err: unknown) => !cancelled && setState((s) => ({ ...s, error: messageOf(err) })),
      )
    void load()
    window.addEventListener(LISTS_CHANGED_EVENT, load)
    return () => {
      cancelled = true
      window.removeEventListener(LISTS_CHANGED_EVENT, load)
    }
  }, [open])
  return state
}

type Confirm =
  | { kind: 'list'; id: string; name: string; count: number }
  | { kind: 'group'; id: string; name: string; count: number }

export function SidebarLists({
  createRequest = null,
  onCreateHandled,
}: {
  /** "New list / folder / group" from ⌘K. */
  createRequest?: CreateRequest | null
  onCreateHandled?: () => void
}) {
  const { data, error, loading, reload } = useSidebarData()
  const prefs = useSidebarPrefs()
  const archived = useArchivedLists(prefs.archivedOpen)
  const pathname = usePathname()
  const searchParams = useSearchParams()
  const activeGroupId = pathname === '/leads' ? (searchParams?.get('group') ?? null) : null
  const router = useRouter()
  const { toast } = useToast()
  const now = useNow()
  const rootRef = useRef<HTMLDivElement>(null)

  const [creating, setCreating] = useState<SidebarUi['creating']>(null)
  const [renaming, setRenaming] = useState<SidebarUi['renaming']>(null)
  const [inlineError, setInlineError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [openMenu, setOpenMenu] = useState<string | null>(null)
  const [dragging, setDragging] = useState<ItemRef | null>(null)
  const [dropTarget, setDropTarget] = useState<DropTarget | null>(null)
  const [confirm, setConfirm] = useState<Confirm | null>(null)
  const [confirmBusy, setConfirmBusy] = useState(false)

  // The order shown while a move is saving (optimistic); cleared once the
  // store has reloaded after the last move, or at once if a call fails.
  const [override, setOverride] = useState<SidebarData | null>(null)
  const shown = override ?? data
  const shownRef = useRef(shown)
  shownRef.current = shown
  const moveQueue = useRef<Promise<void>>(Promise.resolve())
  const movesInFlight = useRef(0)
  const awaitingReload = useRef(false)
  const draggingRef = useRef<ItemRef | null>(null)
  const dropTargetRef = useRef<DropTarget | null>(null)
  // Where keyboard focus goes once that element exists (a new item, a moved row).
  const pendingFocus = useRef<{ selector: string; until: number } | null>(null)

  useEffect(() => {
    if (awaitingReload.current && !loading && movesInFlight.current === 0) {
      awaitingReload.current = false
      setOverride(null)
    }
  }, [loading, data, error])

  useEffect(() => {
    const p = pendingFocus.current
    if (!p) return
    if (Date.now() > p.until) {
      pendingFocus.current = null
      return
    }
    const el = rootRef.current?.querySelector<HTMLElement>(p.selector)
    if (el) {
      el.focus()
      pendingFocus.current = null
    }
  })

  const focusSoon = (selector: string) => {
    pendingFocus.current = { selector, until: Date.now() + 5_000 }
  }
  const focusItem = (id: string) => focusSoon(`[data-sidebar-item="${CSS.escape(id)}"]`)
  const focusCreate = (kind: CreateKind) => focusSoon(`button[aria-label="${CREATE_LABEL[kind]}"]`)

  const startCreate = useCallback(
    (kind: CreateKind, folderId: string | null = null) => {
      setRenaming(null)
      setInlineError(null)
      setCreating({ kind, folderId: kind === 'list' ? folderId : null })
      if (kind === 'list' && folderId) prefs.setFolderCollapsed(folderId, false)
    },
    [prefs],
  )

  // ⌘K "New list / New folder / New group".
  useEffect(() => {
    if (!createRequest) return
    startCreate(createRequest.kind, null)
    onCreateHandled?.()
    // Only a new request (nonce) opens the box again.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [createRequest?.nonce])

  const cancelName = useCallback(() => {
    if (renaming) focusItem(renaming.id)
    else if (creating) focusCreate(creating.kind)
    setCreating(null)
    setRenaming(null)
    setInlineError(null)
  }, [creating, renaming])

  const nameNow = (kind: ItemRef['kind'], id: string): string | undefined => {
    if (kind === 'folder') return shown?.folders.find((f) => f.id === id)?.name
    if (kind === 'group') return shown?.groups.find((g) => g.id === id)?.name
    return shown?.lists.find((l) => l.id === id)?.name ?? archived.lists?.find((l) => l.id === id)?.name
  }

  const submitName = useCallback(
    async (raw: string) => {
      if (raw.trim() === '') return cancelName()
      // The same rule and words as the API [brief §5.1], without a round trip.
      const problem = nameProblem(raw)
      if (problem) return setInlineError(problem)
      setBusy(true)
      setInlineError(null)
      try {
        if (creating) {
          const id =
            creating.kind === 'folder'
              ? (await createFolder(raw)).id
              : creating.kind === 'group'
                ? (await createGroup({ name: raw })).group.id
                : (await createList({ name: raw, folderId: creating.folderId })).list.id
          setCreating(null)
          focusItem(id)
          notifyListsChanged()
        } else if (renaming) {
          if (normalizeName(raw) !== nameNow(renaming.kind, renaming.id)) {
            if (renaming.kind === 'folder') await renameFolder(renaming.id, raw)
            else if (renaming.kind === 'group') await updateGroup(renaming.id, { name: raw })
            else await updateList(renaming.id, { name: raw })
            notifyListsChanged()
          }
          focusItem(renaming.id)
          setRenaming(null)
        }
      } catch (err) {
        setInlineError(messageOf(err))
      } finally {
        setBusy(false)
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [creating, renaming, cancelName, shown, archived.lists],
  )

  const runMove = useCallback(
    (action: MoveAction) => {
      const base = shownRef.current
      if (!base) return
      const plan = planMove(base, action)
      if (!plan) return
      // A second quick move plans on top of this one, and the calls go one after another.
      shownRef.current = plan.next
      setOverride(plan.next)
      movesInFlight.current += 1
      moveQueue.current = moveQueue.current.then(async () => {
        try {
          for (const c of plan.calls) await callApi(c)
        } catch (err) {
          setOverride(null)
          toast({ title: "That move didn't save", description: messageOf(err), tone: 'danger' })
        } finally {
          movesInFlight.current -= 1
          if (movesInFlight.current === 0) {
            awaitingReload.current = true
            notifyListsChanged()
          }
        }
      })
    },
    [toast],
  )

  const setArchived = useCallback(
    async (id: string, archive: boolean) => {
      const name = nameNow('list', id) ?? 'The list'
      try {
        await updateList(id, { archived: archive })
        toast({
          title: archive ? `Archived “${name}”` : `“${name}” is back in your lists`,
          description: archive ? 'It’s under Archived at the bottom of your lists. Nobody was removed from it.' : undefined,
        })
        focusItem(id)
        notifyListsChanged()
      } catch (err) {
        toast({ title: archive ? "Couldn't archive the list" : "Couldn't unarchive the list", description: messageOf(err), tone: 'danger' })
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [toast, shown, archived.lists],
  )

  const menuAction = useCallback(
    (target: ItemRef, action: MenuAction) => {
      setOpenMenu(null)
      switch (action.type) {
        case 'rename':
          setCreating(null)
          setInlineError(null)
          setRenaming({ kind: target.kind, id: target.id })
          return
        case 'newListHere':
          return startCreate('list', target.id)
        case 'move':
          if (target.archived) return
          if (target.kind === 'list') return runMove({ type: 'moveList', listId: target.id, direction: action.direction })
          if (target.kind === 'folder') return runMove({ type: 'moveFolder', folderId: target.id, direction: action.direction })
          return runMove({ type: 'moveGroup', groupId: target.id, direction: action.direction })
        case 'moveTo':
          focusItem(target.id)
          if (!target.archived) return runMove({ type: 'moveListTo', listId: target.id, folderId: action.folderId })
          // An archived list isn't in the sidebar order: just change its folder.
          void updateList(target.id, { folderId: action.folderId }).then(notifyListsChanged, (err: unknown) =>
            toast({ title: "Couldn't move the list", description: messageOf(err), tone: 'danger' }),
          )
          return
        case 'archive':
          return void setArchived(target.id, true)
        case 'unarchive':
          return void setArchived(target.id, false)
        case 'export':
          return downloadUrl(listExportUrl(target.id))
        case 'color':
          void updateGroup(target.id, { color: action.color }).then(notifyListsChanged, (err: unknown) =>
            toast({ title: "Couldn't change the color", description: messageOf(err), tone: 'danger' }),
          )
          return
        case 'delete': {
          if (target.kind === 'folder') {
            // Only offered for an empty folder; the API refuses anything else (409, shown as is).
            const name = nameNow('folder', target.id) ?? 'The folder'
            void deleteFolder(target.id).then(
              () => {
                toast({ title: `Deleted the folder “${name}”` })
                focusCreate('folder')
                notifyListsChanged()
              },
              (err: unknown) => toast({ title: "Couldn't delete the folder", description: messageOf(err), tone: 'danger' }),
            )
            return
          }
          if (target.kind === 'group') {
            const g = shown?.groups.find((x) => x.id === target.id)
            if (g) setConfirm({ kind: 'group', id: g.id, name: g.name, count: g.memberCount })
            return
          }
          const l = shown?.lists.find((x) => x.id === target.id) ?? archived.lists?.find((x) => x.id === target.id)
          if (l) setConfirm({ kind: 'list', id: l.id, name: l.name, count: l.memberCount })
          return
        }
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [runMove, startCreate, setArchived, toast, shown, archived.lists],
  )

  const confirmDelete = async () => {
    if (!confirm) return
    setConfirmBusy(true)
    try {
      if (confirm.kind === 'list') {
        await deleteList(confirm.id)
        toast({ title: `Deleted the list “${confirm.name}”`, description: 'Everyone on it is still in the CRM, in All leads.' })
        if (pathname === `/lists/${confirm.id}`) router.push('/leads')
      } else {
        const r = await deleteGroup(confirm.id)
        toast({ title: `Deleted the group “${confirm.name}”`, description: `Nobody was deleted. The label came off ${peopleCount(r.membershipsRemoved)}.` })
        if (activeGroupId === confirm.id) router.push('/leads')
      }
      focusCreate(confirm.kind)
      setConfirm(null)
      notifyListsChanged()
    } catch (err) {
      toast({ title: `Couldn't delete the ${confirm.kind}`, description: messageOf(err), tone: 'danger' })
    } finally {
      setConfirmBusy(false)
    }
  }

  const rowKeyDown = useCallback(
    (target: ItemRef, e: React.KeyboardEvent) => {
      if (e.key === 'F2') {
        e.preventDefault()
        return menuAction(target, { type: 'rename' })
      }
      if ((e.shiftKey && e.key === 'F10') || e.key === 'ContextMenu') {
        e.preventDefault()
        return setOpenMenu(menuKey(target))
      }
      if (e.altKey && !e.metaKey && !e.ctrlKey && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) {
        e.preventDefault()
        e.stopPropagation()
        return menuAction(target, { type: 'move', direction: e.key === 'ArrowUp' ? 'up' : 'down' })
      }
      if (target.kind === 'folder' && (e.key === 'ArrowLeft' || e.key === 'ArrowRight') && !e.altKey && !e.metaKey && !e.ctrlKey) {
        e.preventDefault()
        prefs.setFolderCollapsed(target.id, e.key === 'ArrowLeft')
      }
    },
    [menuAction, prefs],
  )

  // ↑ / ↓ walk the sidebar's rows (All leads, folders, lists, Archived, groups).
  const onTreeKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if ((e.key !== 'ArrowDown' && e.key !== 'ArrowUp') || e.altKey || e.metaKey || e.ctrlKey || e.shiftKey) return
    const current = (e.target as HTMLElement).closest('[data-sidebar-row]')
    if (!current || !rootRef.current) return
    const rows = [...rootRef.current.querySelectorAll<HTMLElement>('[data-sidebar-row]')]
    const next = rows[rows.indexOf(current as HTMLElement) + (e.key === 'ArrowDown' ? 1 : -1)]
    if (next) {
      e.preventDefault()
      next.focus()
    }
  }

  const ui: SidebarUi = {
    creating,
    renaming,
    inlineError,
    busy,
    openMenu,
    dragging,
    dropTarget,
    startCreate,
    submitName: (name) => void submitName(name),
    cancelName,
    setOpenMenu,
    menuAction,
    toggleFolder: prefs.toggleFolder,
    toggleArchived: prefs.toggleArchived,
    retry: () => void reload(),
    rowKeyDown,
    dragStart: (target, e) => {
      e.dataTransfer.effectAllowed = 'move'
      e.dataTransfer.setData('text/plain', target.id) // Firefox only starts a drag that carries data
      draggingRef.current = target
      setDragging(target)
      setOpenMenu(null)
    },
    dragOver: (over, e) => {
      const drag = draggingRef.current
      if (!drag) return
      const rect = e.currentTarget.getBoundingClientRect()
      const position = dropPosition(drag, over, e.clientY < rect.top + rect.height / 2)
      if (!position) return
      e.preventDefault()
      e.dataTransfer.dropEffect = 'move'
      const cur = dropTargetRef.current
      if (cur && cur.kind === over.kind && cur.id === over.id && cur.position === position) return
      dropTargetRef.current = { ...over, position }
      setDropTarget(dropTargetRef.current)
    },
    drop: (e) => {
      e.preventDefault()
      const drag = draggingRef.current
      const target = dropTargetRef.current
      draggingRef.current = null
      dropTargetRef.current = null
      setDragging(null)
      setDropTarget(null)
      if (!drag || !target) return
      const action = dropAction(drag, target)
      if (action) runMove(action)
    },
    dragEnd: () => {
      draggingRef.current = null
      dropTargetRef.current = null
      setDragging(null)
      setDropTarget(null)
    },
  }

  return (
    <SidebarUiContext.Provider value={ui}>
      <div
        ref={rootRef}
        onKeyDown={onTreeKeyDown}
        onDragLeave={(e) => {
          if (!rootRef.current?.contains(e.relatedTarget as Node | null)) {
            dropTargetRef.current = null
            setDropTarget(null)
          }
        }}
      >
        <SidebarTree
          data={shown}
          loading={loading}
          error={shown ? null : error}
          now={now}
          pathname={pathname}
          activeGroupId={activeGroupId}
          collapsedFolderIds={prefs.collapsed}
          archivedOpen={prefs.archivedOpen}
          archivedLists={archived.lists}
          archivedError={archived.error}
        />
      </div>
      <ConfirmDialog
        open={confirm !== null}
        busy={confirmBusy}
        title={confirm ? `Delete the ${confirm.kind} “${confirm.name}”?` : ''}
        confirmLabel={confirm?.kind === 'group' ? 'Delete group' : 'Delete list'}
        body={
          confirm?.kind === 'group' ? (
            <p>Nobody is deleted: the label comes off {peopleCount(confirm.count)}.</p>
          ) : confirm ? (
            <p>
              The people stay in the CRM; only the list goes away.
              {confirm.count > 0 && ` ${peopleCount(confirm.count)} ${confirm.count === 1 ? 'is' : 'are'} on it now, and stay in All leads.`}
            </p>
          ) : null
        }
        onConfirm={() => void confirmDelete()}
        onCancel={() => {
          if (confirm) focusItem(confirm.id)
          setConfirm(null)
        }}
        onClosed={() => {
          // Focus the row again (cancel) or the + button (deleted), once it's there.
          const p = pendingFocus.current
          const el = p ? rootRef.current?.querySelector<HTMLElement>(p.selector) : null
          if (el) {
            el.focus()
            pendingFocus.current = null
          }
        }}
      />
    </SidebarUiContext.Provider>
  )
}
