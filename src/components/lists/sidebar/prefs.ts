'use client'

// Brief 45 — the sidebar's per-browser memory: which folders are collapsed and
// whether the Archived section is open (brief §5.2: folders open and close,
// remembered per browser). One small store shared by every sidebar on the page
// (the left column and the phone drawer), saved in localStorage. Storage can be
// missing or blocked (private windows): then it simply isn't remembered.
import { useCallback, useSyncExternalStore } from 'react'

const COLLAPSED_KEY = 'dealflow-sidebar-collapsed-folders'
const ARCHIVED_KEY = 'dealflow-sidebar-archived-open'

export interface SidebarPrefs {
  collapsed: ReadonlySet<string>
  archivedOpen: boolean
}

const SERVER: SidebarPrefs = { collapsed: new Set(), archivedOpen: false }
let prefs: SidebarPrefs | null = null
const subscribers = new Set<() => void>()

function read(): SidebarPrefs {
  try {
    const ids: unknown = JSON.parse(window.localStorage.getItem(COLLAPSED_KEY) ?? '[]')
    return {
      collapsed: new Set(Array.isArray(ids) ? ids.filter((x): x is string => typeof x === 'string') : []),
      archivedOpen: window.localStorage.getItem(ARCHIVED_KEY) === '1',
    }
  } catch {
    return SERVER
  }
}

function snapshot(): SidebarPrefs {
  if (!prefs) prefs = read()
  return prefs
}

function save(next: SidebarPrefs): void {
  prefs = next
  try {
    window.localStorage.setItem(COLLAPSED_KEY, JSON.stringify([...next.collapsed]))
    window.localStorage.setItem(ARCHIVED_KEY, next.archivedOpen ? '1' : '0')
  } catch {
    /* not remembered this time; the sidebar still works */
  }
  for (const fn of subscribers) fn()
}

function subscribe(fn: () => void): () => void {
  subscribers.add(fn)
  return () => subscribers.delete(fn)
}

export function useSidebarPrefs(): SidebarPrefs & {
  setFolderCollapsed: (folderId: string, collapsed: boolean) => void
  toggleFolder: (folderId: string) => void
  toggleArchived: () => void
} {
  const current = useSyncExternalStore(subscribe, snapshot, () => SERVER)
  const setFolderCollapsed = useCallback((folderId: string, collapsed: boolean) => {
    const now = snapshot()
    if (now.collapsed.has(folderId) === collapsed) return
    const next = new Set(now.collapsed)
    if (collapsed) next.add(folderId)
    else next.delete(folderId)
    save({ ...now, collapsed: next })
  }, [])
  const toggleFolder = useCallback(
    (folderId: string) => setFolderCollapsed(folderId, !snapshot().collapsed.has(folderId)),
    [setFolderCollapsed],
  )
  const toggleArchived = useCallback(() => save({ ...snapshot(), archivedOpen: !snapshot().archivedOpen }), [])
  return { ...current, setFolderCollapsed, toggleFolder, toggleArchived }
}
