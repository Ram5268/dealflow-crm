// Brief 45 — what the ⌘K palette offers for folders, lists and groups
// (brief §5.2): "Go to list…" and "Go to group…" (each opens a page of the
// palette listing them) and "New list" / "New folder" / "New group" (each
// opens the sidebar's inline name box). Pure, so it can be tested without a
// browser. "Open Pipeline" is one of the palette's own actions (PR D).
import type { GroupColor, SidebarData } from '@/lib/core-data/lists/types'
import type { CreateKind } from './createRequest'

export type ListPaletteCommand =
  | { id: string; label: string; page: 'lists' | 'groups' }
  | { id: string; label: string; create: CreateKind }

export const LIST_PALETTE_COMMANDS: readonly ListPaletteCommand[] = [
  { id: 'go-list', label: 'Go to list…', page: 'lists' },
  { id: 'go-group', label: 'Go to group…', page: 'groups' },
  { id: 'new-list', label: 'New list', create: 'list' },
  { id: 'new-folder', label: 'New folder', create: 'folder' },
  { id: 'new-group', label: 'New group', create: 'group' },
]

export interface PaletteListEntry {
  id: string
  label: string
  /** The folder's name, or "No folder". */
  detail: string
  count: number
  href: string
}

export interface PaletteGroupEntry {
  id: string
  label: string
  color: GroupColor
  count: number
  href: string
}

/** Every active list in sidebar order, with its folder. */
export function paletteListEntries(data: SidebarData | null): PaletteListEntry[] {
  if (!data) return []
  const folderName = new Map(data.folders.map((f) => [f.id, f.name]))
  return data.lists.map((l) => ({
    id: l.id,
    label: l.name,
    detail: (l.folderId && folderName.get(l.folderId)) || 'No folder',
    count: l.memberCount,
    href: `/lists/${encodeURIComponent(l.id)}`,
  }))
}

/** Every group in sidebar order; each opens the Pipeline on that group. */
export function paletteGroupEntries(data: SidebarData | null): PaletteGroupEntry[] {
  if (!data) return []
  return data.groups.map((g) => ({
    id: g.id,
    label: g.name,
    color: g.color,
    count: g.memberCount,
    href: groupHref(g.id),
  }))
}

/**
 * Where clicking a group goes (the sidebar and ⌘K use the same place): the
 * Pipeline showing that group's column [brief §5.2: "a group opens the
 * Pipeline filtered to that group"]. Before the Pipeline (PR D) it was All
 * leads filtered to the group; /leads?group=<id> still works for old links.
 */
export const groupHref = (groupId: string) => `/pipeline?groups=${encodeURIComponent(groupId)}`

/** Where a saved Pipeline workflow opens: its tab, as saved (the sidebar's Workflows and the Pipeline's tabs). */
export const workflowHref = (workflowId: string) => `/pipeline?wf=${encodeURIComponent(workflowId)}`
