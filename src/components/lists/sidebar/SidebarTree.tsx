'use client'

// Brief 45 — the Mojo-style part of the left sidebar (brief §5.2), drawn from
// data: All leads (always there, never deletable) with its live count and the
// "ranked 7:02" stamp; LISTS: folders holding lists, lists outside folders,
// the archived lists; GROUPS with their color and count. The CRM starts with
// no folders, lists or groups: Ryan creates every one [Ryan, 2026-10-18].
//
// Everything interactive (inline name boxes, menus, drag and drop, keys)
// comes from SidebarUiContext, which SidebarLists provides. With the default
// (inert) context the tree still renders completely, which is how the render
// tests draw it. Nothing here contacts anyone: it only organizes.
import Link from 'next/link'
import { createContext, useContext, useId, useRef, useState } from 'react'
import * as RM from '@radix-ui/react-dropdown-menu'
import { Check, ChevronDown, ChevronRight, MoreHorizontal, Plus, Users } from 'lucide-react'
import { Skeleton, Tooltip } from '@/components/ui'
import { controlBase } from '@/components/ui/Field'
import { cn } from '@/lib/ui/cn'
import { GROUP_COLOR_OPTIONS, groupColorStyle } from '@/lib/ui/groupColors'
import type { FolderDTO, GroupColor, GroupDTO, ListDTO, SidebarData } from '@/lib/core-data/lists/types'
import { formatCount, rankedHeadline, rankedStamp } from '../format'
import { buildTree, canStep, type Direction } from './tree'
import { groupHref } from './palette'
import type { CreateKind } from './createRequest'

// ─── The interactive state, provided by SidebarLists ─────────────────────────

export type ItemKind = 'folder' | 'list' | 'group'

export interface ItemRef {
  kind: ItemKind
  id: string
  /** An archived list (its menu offers Unarchive; it can't be dragged). */
  archived?: boolean
}

export type DropPosition = 'before' | 'after' | 'into'

export interface DropTarget {
  kind: ItemKind | 'outside'
  id: string
  position: DropPosition
}

export type MenuAction =
  | { type: 'rename' }
  | { type: 'move'; direction: Direction }
  | { type: 'moveTo'; folderId: string | null }
  | { type: 'archive' }
  | { type: 'unarchive' }
  | { type: 'export' }
  | { type: 'delete' }
  | { type: 'color'; color: GroupColor }
  | { type: 'newListHere' }

export interface SidebarUi {
  /** The open "new …" name box: a folder, a group, or a list (in a folder, or outside with null). */
  creating: { kind: CreateKind; folderId: string | null } | null
  renaming: { kind: ItemKind; id: string } | null
  /** The API's refusal (e.g. the 409 duplicate message), shown under the name box word for word. */
  inlineError: string | null
  busy: boolean
  /** Which ⋯ menu is open (menuKey). */
  openMenu: string | null
  dragging: ItemRef | null
  dropTarget: DropTarget | null
  startCreate: (kind: CreateKind, folderId?: string | null) => void
  submitName: (name: string) => void
  /** Esc returns focus to the row (or the + button); clicking away leaves focus where it went. */
  cancelName: (opts?: { refocus?: boolean }) => void
  setOpenMenu: (key: string | null) => void
  menuAction: (item: ItemRef, action: MenuAction) => void
  toggleFolder: (folderId: string) => void
  toggleArchived: () => void
  retry: () => void
  dragStart: (item: ItemRef, e: React.DragEvent) => void
  dragOver: (target: { kind: ItemKind | 'outside'; id: string }, e: React.DragEvent) => void
  drop: (e: React.DragEvent) => void
  dragEnd: () => void
  rowKeyDown: (item: ItemRef, e: React.KeyboardEvent) => void
}

const noop = () => {}

export const inertSidebarUi: SidebarUi = {
  creating: null, renaming: null, inlineError: null, busy: false, openMenu: null, dragging: null, dropTarget: null,
  startCreate: noop, submitName: noop, cancelName: noop, setOpenMenu: noop, menuAction: noop, toggleFolder: noop,
  toggleArchived: noop, retry: noop, dragStart: noop, dragOver: noop, drop: noop, dragEnd: noop, rowKeyDown: noop,
}

export const SidebarUiContext = createContext<SidebarUi>(inertSidebarUi)

export const menuKey = (item: { kind: ItemKind; id: string }) => `${item.kind}:${item.id}`

// ─── Look ─────────────────────────────────────────────────────────────────────
// Row text starts at 30px, the main nav's label column (8px pad + 14px icon +
// 8px gap); a list inside a folder starts at 44px. Rows are 28px, a step under
// the 30px nav rows, like Close's sub-rows.

const TEXT_AT = { 0: 'pl-[30px]', 1: 'pl-[44px]' } as const
const BOX_AT = { 0: 'pl-[22px]', 1: 'pl-[36px]' } as const // a name box's own 8px padding lines its text up

function rowShell(active: boolean, drop: DropPosition | null): string {
  return cn(
    'group/row relative flex h-7 items-center rounded-md transition-colors duration-75',
    active ? 'bg-active' : 'hover:bg-hover',
    drop === 'before' && 'shadow-[inset_0_2px_0_0_var(--accent)]',
    drop === 'after' && 'shadow-[inset_0_-2px_0_0_var(--accent)]',
    drop === 'into' && 'bg-accent-subtle ring-1 ring-inset ring-accent',
  )
}

const ROW_MAIN = 'flex h-full min-w-0 flex-1 items-center gap-2 rounded-md pr-1 text-sm text-fg hover:text-fg-strong'
const COUNT = 'shrink-0 text-xs tabular-nums text-subtle'
const MENU_BUTTON = cn(
  'mr-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded text-subtle transition-opacity duration-75',
  'hover:bg-active hover:text-fg',
  // Shown on hover or keyboard focus, always on touch screens, and while its menu is open.
  'opacity-0 group-hover/row:opacity-100 group-focus-within/row:opacity-100 focus-visible:opacity-100',
  'data-[state=open]:opacity-100 [@media(hover:none)]:opacity-100',
)
// No text color here: an item is text-fg or (Delete) text-danger, never both.
const MENU_ITEM = cn(
  'flex h-7 cursor-default select-none items-center gap-2 rounded px-2 text-sm outline-none',
  'data-[highlighted]:bg-hover data-[disabled]:pointer-events-none data-[disabled]:opacity-50',
)
const MENU_CONTENT = cn(
  'z-50 min-w-48 rounded-md border border-line bg-overlay p-1 shadow-md',
  'data-[state=open]:animate-[dfFadeIn_100ms_ease-out]',
)

function dropFor(ui: SidebarUi, kind: ItemKind, id: string): DropPosition | null {
  return ui.dropTarget && ui.dropTarget.kind === kind && ui.dropTarget.id === id ? ui.dropTarget.position : null
}

// ─── The ⋯ menu (also opened by right-click, Shift+F10 or the menu key) ──────

type MenuEntry =
  | { kind: 'item'; label: string; action: MenuAction; hint?: string; disabled?: boolean; danger?: boolean; reason?: string }
  | { kind: 'sub'; label: string; options: { label: string; action: MenuAction; checked?: boolean; dot?: string }[] }
  | { kind: 'separator' }

const SEPARATOR: MenuEntry = { kind: 'separator' }
const item = (label: string, action: MenuAction, extra: Partial<Extract<MenuEntry, { kind: 'item' }>> = {}): MenuEntry => ({
  kind: 'item', label, action, ...extra,
})

/** Actions after which focus belongs somewhere else (a name box, a dialog, the row's new place). */
const MOVES_FOCUS = new Set<MenuAction['type']>(['rename', 'newListHere', 'delete', 'moveTo', 'archive', 'unarchive'])

function ItemMenu({ target, name, entries }: { target: ItemRef; name: string; entries: MenuEntry[] }) {
  const ui = useContext(SidebarUiContext)
  const key = menuKey(target)
  const keepFocus = useRef(false)
  const reasonBase = useId()
  const choose = (action: MenuAction) => {
    keepFocus.current = MOVES_FOCUS.has(action.type)
    ui.menuAction(target, action)
  }
  return (
    <RM.Root open={ui.openMenu === key} onOpenChange={(o) => ui.setOpenMenu(o ? key : null)}>
      <RM.Trigger asChild>
        <button type="button" aria-label={`More actions for ${name}`} className={MENU_BUTTON}>
          <MoreHorizontal size={14} />
        </button>
      </RM.Trigger>
      <RM.Portal>
        <RM.Content
          align="start"
          sideOffset={4}
          className={MENU_CONTENT}
          onCloseAutoFocus={(e) => {
            if (keepFocus.current) e.preventDefault()
            keepFocus.current = false
          }}
        >
          {entries.map((entry, i) => {
            if (entry.kind === 'separator') return <RM.Separator key={i} className="my-1 h-px bg-line" />
            if (entry.kind === 'sub') {
              return (
                <RM.Sub key={i}>
                  <RM.SubTrigger className={cn(MENU_ITEM, 'text-fg')} disabled={entry.options.length === 0}>
                    <span className="min-w-0 flex-1 truncate">{entry.label}</span>
                    <ChevronRight size={13} className="shrink-0 text-subtle" />
                  </RM.SubTrigger>
                  <RM.Portal>
                    <RM.SubContent sideOffset={4} className={cn(MENU_CONTENT, 'max-h-72 overflow-y-auto')}>
                      {entry.options.map((o) => (
                        <RM.Item key={o.label} className={cn(MENU_ITEM, 'text-fg')} onSelect={() => choose(o.action)}>
                          {o.dot && <span aria-hidden="true" className={cn('h-2 w-2 shrink-0 rounded-full', o.dot)} />}
                          <span className="min-w-0 flex-1 truncate">{o.label}</span>
                          {o.checked && <Check size={13} className="shrink-0 text-accent" aria-label="current" />}
                        </RM.Item>
                      ))}
                    </RM.SubContent>
                  </RM.Portal>
                </RM.Sub>
              )
            }
            const reasonId = entry.reason ? `${reasonBase}-${i}` : undefined
            return (
              <div key={i}>
                <RM.Item
                  className={cn(MENU_ITEM, entry.danger ? 'text-danger' : 'text-fg')}
                  disabled={entry.disabled}
                  aria-describedby={reasonId}
                  onSelect={() => choose(entry.action)}
                >
                  <span className="min-w-0 flex-1 truncate">{entry.label}</span>
                  {entry.hint && <span className="shrink-0 text-xs text-subtle">{entry.hint}</span>}
                </RM.Item>
                {/* Greyed out with the reason underneath, not hidden. */}
                {entry.reason && (
                  <p id={reasonId} className="max-w-60 px-2 pb-1 text-xs text-subtle">
                    {entry.reason}
                  </p>
                )}
              </div>
            )
          })}
        </RM.Content>
      </RM.Portal>
    </RM.Root>
  )
}

const moveItems = (ids: string[], id: string): MenuEntry[] => [
  item('Move up', { type: 'move', direction: 'up' }, { hint: '⌥↑', disabled: !canStep(ids, id, 'up') }),
  item('Move down', { type: 'move', direction: 'down' }, { hint: '⌥↓', disabled: !canStep(ids, id, 'down') }),
]

/** The plain reason a folder can't be deleted yet (the API's own wording), or null. */
export function folderNotEmptyReason(folder: Pick<FolderDTO, 'listCount' | 'archivedListCount'>): string | null {
  const n = folder.listCount
  if (n === 0) return null
  const archived = folder.archivedListCount ? ` (${folder.archivedListCount} archived)` : ''
  return `This folder still has ${n} ${n === 1 ? 'list' : 'lists'}${archived}. Move or delete ${n === 1 ? 'it' : 'them'} first.`
}

function folderMenu(folder: FolderDTO, folderIds: string[]): MenuEntry[] {
  const reason = folderNotEmptyReason(folder)
  return [
    item('Rename', { type: 'rename' }, { hint: 'F2' }),
    item('New list in this folder', { type: 'newListHere' }),
    ...moveItems(folderIds, folder.id),
    SEPARATOR,
    // A folder can be deleted only when it has no lists at all [brief §5.1].
    item('Delete folder', { type: 'delete' }, { danger: true, disabled: reason !== null, reason: reason ?? undefined }),
  ]
}

function listMenu(list: ListDTO, scopeIds: string[], folders: FolderDTO[], archived: boolean): MenuEntry[] {
  const targets = [
    ...folders.filter((f) => f.id !== list.folderId).map((f) => ({ label: f.name, action: { type: 'moveTo', folderId: f.id } as MenuAction })),
    ...(list.folderId !== null ? [{ label: 'No folder (outside folders)', action: { type: 'moveTo', folderId: null } as MenuAction }] : []),
  ]
  return [
    item('Rename', { type: 'rename' }, { hint: 'F2' }),
    ...(archived ? [] : moveItems(scopeIds, list.id)),
    { kind: 'sub', label: 'Move to folder…', options: targets },
    SEPARATOR,
    archived ? item('Unarchive', { type: 'unarchive' }) : item('Archive', { type: 'archive' }),
    item('Export CSV', { type: 'export' }),
    SEPARATOR,
    item('Delete list…', { type: 'delete' }, { danger: true }),
  ]
}

function groupMenu(group: GroupDTO, groupIds: string[]): MenuEntry[] {
  return [
    item('Rename', { type: 'rename' }, { hint: 'F2' }),
    {
      kind: 'sub',
      label: 'Color',
      options: GROUP_COLOR_OPTIONS.map((o) => ({ label: o.label, action: { type: 'color', color: o.value }, checked: o.value === group.color, dot: o.dot })),
    },
    ...moveItems(groupIds, group.id),
    SEPARATOR,
    item('Delete group…', { type: 'delete' }, { danger: true }),
  ]
}

// ─── Name boxes (create and rename) ───────────────────────────────────────────

function NameBox({ placeholder, label, initial = '', at }: { placeholder: string; label: string; initial?: string; at: string }) {
  const ui = useContext(SidebarUiContext)
  const [value, setValue] = useState(initial)
  const errorId = useId()
  const error = ui.inlineError
  return (
    <div className={cn('py-0.5 pr-1', at)} data-inline-name>
      <input
        autoFocus
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onFocus={(e) => e.currentTarget.select()}
        placeholder={placeholder}
        aria-label={label}
        aria-invalid={error ? true : undefined}
        aria-describedby={error ? errorId : undefined}
        aria-busy={ui.busy || undefined}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault()
            if (!ui.busy) ui.submitName(value)
          } else if (e.key === 'Escape') {
            e.preventDefault()
            e.stopPropagation()
            ui.cancelName()
          }
        }}
        // Clicking away closes an untouched box; typed text is kept until Enter or Esc.
        onBlur={() => {
          if (!ui.busy && (value.trim() === '' || value === initial)) ui.cancelName({ refocus: false })
        }}
        className={cn(controlBase, error ? 'border-danger' : 'border-line hover:border-line-strong', 'h-7')}
      />
      {error && (
        <p id={errorId} role="alert" className="mt-1 px-0.5 text-xs text-danger">
          {error}
        </p>
      )}
    </div>
  )
}

// ─── Rows ─────────────────────────────────────────────────────────────────────

function ListRow({
  list, depth, scopeIds, folders, active, archived = false,
}: {
  list: ListDTO
  depth: 0 | 1
  scopeIds: string[]
  folders: FolderDTO[]
  active: boolean
  archived?: boolean
}) {
  const ui = useContext(SidebarUiContext)
  const ref: ItemRef = { kind: 'list', id: list.id, archived }
  if (ui.renaming?.kind === 'list' && ui.renaming.id === list.id) {
    return (
      <li>
        <NameBox placeholder="List name" label={`New name for ${list.name}`} initial={list.name} at={BOX_AT[depth]} />
      </li>
    )
  }
  return (
    <li>
      <div
        className={rowShell(active, dropFor(ui, 'list', list.id))}
        onContextMenu={(e) => {
          e.preventDefault()
          ui.setOpenMenu(menuKey(ref))
        }}
        onDragOver={archived ? undefined : (e) => ui.dragOver({ kind: 'list', id: list.id }, e)}
        onDrop={archived ? undefined : ui.drop}
      >
        <Link
          href={`/lists/${encodeURIComponent(list.id)}`}
          aria-current={active ? 'page' : undefined}
          data-sidebar-row=""
          data-sidebar-item={list.id}
          draggable={!archived}
          onDragStart={archived ? undefined : (e) => ui.dragStart(ref, e)}
          onDragEnd={ui.dragEnd}
          onDoubleClick={() => ui.menuAction(ref, { type: 'rename' })}
          onKeyDown={(e) => ui.rowKeyDown(ref, e)}
          className={cn(ROW_MAIN, TEXT_AT[depth], archived && 'text-muted')}
        >
          <span className="min-w-0 flex-1 truncate" title={list.name}>
            {list.name}
          </span>
          <span className={COUNT}>{formatCount(list.memberCount)}</span>
        </Link>
        <ItemMenu target={ref} name={list.name} entries={listMenu(list, scopeIds, folders, archived)} />
      </div>
    </li>
  )
}

function FolderRow({
  folder, lists, folderIds, folders, expanded, pathname,
}: {
  folder: FolderDTO
  lists: ListDTO[]
  folderIds: string[]
  folders: FolderDTO[]
  expanded: boolean
  pathname: string | null
}) {
  const ui = useContext(SidebarUiContext)
  const ref: ItemRef = { kind: 'folder', id: folder.id }
  const creatingHere = ui.creating?.kind === 'list' && ui.creating.folderId === folder.id
  const scopeIds = lists.map((l) => l.id)
  const renaming = ui.renaming?.kind === 'folder' && ui.renaming.id === folder.id
  return (
    <li>
      {renaming ? (
        <NameBox placeholder="Folder name" label={`New name for ${folder.name}`} initial={folder.name} at={BOX_AT[0]} />
      ) : (
        <div
          className={rowShell(false, dropFor(ui, 'folder', folder.id))}
          onContextMenu={(e) => {
            e.preventDefault()
            ui.setOpenMenu(menuKey(ref))
          }}
          onDragOver={(e) => ui.dragOver({ kind: 'folder', id: folder.id }, e)}
          onDrop={ui.drop}
        >
          <button
            type="button"
            aria-expanded={expanded}
            data-sidebar-row=""
            data-sidebar-item={folder.id}
            draggable
            onDragStart={(e) => ui.dragStart(ref, e)}
            onDragEnd={ui.dragEnd}
            // The second click of a double-click renames instead of toggling back.
            onClick={(e) => {
              if (e.detail <= 1) ui.toggleFolder(folder.id)
            }}
            onDoubleClick={() => ui.menuAction(ref, { type: 'rename' })}
            onKeyDown={(e) => ui.rowKeyDown(ref, e)}
            className={cn(ROW_MAIN, 'pl-2 text-left font-medium')}
          >
            {expanded ? (
              <ChevronDown size={14} className="shrink-0 text-subtle" />
            ) : (
              <ChevronRight size={14} className="shrink-0 text-subtle" />
            )}
            <span className="min-w-0 flex-1 truncate" title={folder.name}>
            {folder.name}
          </span>
          </button>
          <ItemMenu target={ref} name={folder.name} entries={folderMenu(folder, folderIds)} />
        </div>
      )}
      {((expanded && lists.length > 0) || creatingHere) && (
        <ul role="list" className="flex flex-col gap-px">
          {expanded &&
            lists.map((l) => (
              <ListRow key={l.id} list={l} depth={1} scopeIds={scopeIds} folders={folders} active={pathname === `/lists/${l.id}`} />
            ))}
          {creatingHere && (
            <li>
              <NameBox placeholder="List name" label={`New list in ${folder.name}`} at={BOX_AT[1]} />
            </li>
          )}
        </ul>
      )}
    </li>
  )
}

function GroupRow({ group, groupIds, active }: { group: GroupDTO; groupIds: string[]; active: boolean }) {
  const ui = useContext(SidebarUiContext)
  const ref: ItemRef = { kind: 'group', id: group.id }
  if (ui.renaming?.kind === 'group' && ui.renaming.id === group.id) {
    return (
      <li>
        <NameBox placeholder="Group name" label={`New name for ${group.name}`} initial={group.name} at={BOX_AT[0]} />
      </li>
    )
  }
  return (
    <li>
      <div
        className={rowShell(active, dropFor(ui, 'group', group.id))}
        onContextMenu={(e) => {
          e.preventDefault()
          ui.setOpenMenu(menuKey(ref))
        }}
        onDragOver={(e) => ui.dragOver({ kind: 'group', id: group.id }, e)}
        onDrop={ui.drop}
      >
        <Link
          href={groupHref(group.id)}
          aria-current={active ? 'page' : undefined}
          data-sidebar-row=""
          data-sidebar-item={group.id}
          draggable
          onDragStart={(e) => ui.dragStart(ref, e)}
          onDragEnd={ui.dragEnd}
          onDoubleClick={() => ui.menuAction(ref, { type: 'rename' })}
          onKeyDown={(e) => ui.rowKeyDown(ref, e)}
          className={cn(ROW_MAIN, 'pl-2')}
        >
          <span aria-hidden="true" className="flex w-3.5 shrink-0 justify-center">
            <span className={cn('h-2 w-2 rounded-full', groupColorStyle(group.color).dot)} />
          </span>
          <span className="min-w-0 flex-1 truncate" title={group.name}>
            {group.name}
          </span>
          <span className={COUNT}>{formatCount(group.memberCount)}</span>
        </Link>
        <ItemMenu target={ref} name={group.name} entries={groupMenu(group, groupIds)} />
      </div>
    </li>
  )
}

function SectionHeader({ id, title, actions }: { id: string; title: string; actions: { label: string; text: string; onClick: () => void }[] }) {
  return (
    <div className="flex h-7 items-center gap-0.5 pl-2 pr-1">
      {/* Close's section label step: 11px/600 uppercase, as in the ⌘K palette. */}
      <h2 id={id} className="min-w-0 flex-1 truncate text-[11px] font-semibold uppercase tracking-wide text-subtle">
        {title}
      </h2>
      {actions.map((a) => (
        <button
          key={a.label}
          type="button"
          aria-label={a.label}
          onClick={a.onClick}
          className="flex h-6 shrink-0 items-center gap-0.5 rounded px-1.5 text-xs font-medium text-subtle transition-colors hover:bg-hover hover:text-fg"
        >
          <Plus size={12} />
          {a.text}
        </button>
      ))}
    </div>
  )
}

const LISTS_EMPTY = 'No lists yet. Upload a spreadsheet or create a list.'
const GROUPS_EMPTY = 'No groups yet. Create groups like Hot or Nurture to sort people as you talk to them.'

// ─── The tree ─────────────────────────────────────────────────────────────────

export interface SidebarTreeProps {
  data: SidebarData | null
  loading?: boolean
  error?: string | null
  /** For the "ranked 7:02" stamp. */
  now: Date
  pathname?: string | null
  /** The group being viewed on /leads?group=<id>. */
  activeGroupId?: string | null
  collapsedFolderIds?: ReadonlySet<string>
  archivedOpen?: boolean
  /** null while loading them. */
  archivedLists?: ListDTO[] | null
  archivedError?: string | null
}

export function SidebarTree({
  data, error = null, now, pathname = null, activeGroupId = null, collapsedFolderIds, archivedOpen = false,
  archivedLists = null, archivedError = null,
}: SidebarTreeProps) {
  const ui = useContext(SidebarUiContext)
  const listsId = useId()
  const groupsId = useId()
  const tree = data ? buildTree(data) : null
  const folderIds = data ? data.folders.map((f) => f.id) : []
  const groupIds = data ? data.groups.map((g) => g.id) : []
  const rootIds = tree ? tree.rootLists.map((l) => l.id) : []
  const draggedList = ui.dragging?.kind === 'list' && data ? data.lists.find((l) => l.id === ui.dragging!.id) : undefined
  const allLeadsActive = pathname === '/leads' && !activeGroupId
  const stamp = data ? rankedStamp(data.allLeads.rankedAt, now) : null

  return (
    <div className="mt-3 flex flex-col gap-3 border-t border-line-subtle pt-3">
      {/* All leads: every homeowner in the CRM, in today's rank order. Always here. */}
      <div className={rowShell(allLeadsActive, null)}>
        <Link
          href="/leads"
          aria-current={allLeadsActive ? 'page' : undefined}
          data-sidebar-row=""
          className={cn(ROW_MAIN, 'pl-2 font-medium')}
        >
          <Users size={14} className="shrink-0" />
          <span className="min-w-0 flex-1 truncate">All leads</span>
          {data && <span className={COUNT}>{formatCount(data.allLeads.count)}</span>}
          {data && (
            <Tooltip content={stamp ? `${rankedHeadline(data.allLeads.rankedAt, now)} (New York time)` : null}>
              <span className="shrink-0 text-xs text-subtle">{stamp ?? 'not ranked yet'}</span>
            </Tooltip>
          )}
        </Link>
      </div>

      <section aria-labelledby={listsId}>
        <SectionHeader
          id={listsId}
          title="Lists"
          actions={[
            { label: 'New folder', text: 'Folder', onClick: () => ui.startCreate('folder') },
            { label: 'New list', text: 'List', onClick: () => ui.startCreate('list', null) },
          ]}
        />
        {error ? (
          <p className="px-2 py-1 text-xs text-danger">
            {error}{' '}
            <button type="button" onClick={ui.retry} className="font-medium underline underline-offset-2">
              Try again
            </button>
          </p>
        ) : !data || !tree ? (
          <div aria-busy="true" className="flex flex-col gap-1.5 px-2 py-1">
            <Skeleton className="h-4 w-3/4" />
            <Skeleton className="h-4 w-1/2" />
          </div>
        ) : (
          <>
            <ul role="list" className="flex flex-col gap-px">
              {tree.folders.map(({ folder, lists }) => (
                <FolderRow
                  key={folder.id}
                  folder={folder}
                  lists={lists}
                  folderIds={folderIds}
                  folders={data.folders}
                  expanded={!collapsedFolderIds?.has(folder.id)}
                  pathname={pathname}
                />
              ))}
              {ui.creating?.kind === 'folder' && (
                <li>
                  <NameBox placeholder="Folder name" label="New folder name" at={BOX_AT[0]} />
                </li>
              )}
              {tree.rootLists.map((l) => (
                <ListRow key={l.id} list={l} depth={0} scopeIds={rootIds} folders={data.folders} active={pathname === `/lists/${l.id}`} />
              ))}
              {ui.creating?.kind === 'list' && ui.creating.folderId === null && (
                <li>
                  <NameBox placeholder="List name" label="New list name" at={BOX_AT[0]} />
                </li>
              )}
              {draggedList && draggedList.folderId !== null && (
                <li>
                  <div
                    onDragOver={(e) => ui.dragOver({ kind: 'outside', id: 'outside' }, e)}
                    onDrop={ui.drop}
                    className={cn(
                      'ml-[22px] mr-1 mt-0.5 flex h-7 items-center rounded-md border border-dashed px-2 text-xs',
                      ui.dropTarget?.kind === 'outside' ? 'border-accent bg-accent-subtle text-accent' : 'border-line-strong text-subtle',
                    )}
                  >
                    Drop here to take it out of the folder
                  </div>
                </li>
              )}
            </ul>
            {data.lists.length === 0 && data.archivedCount === 0 && !(ui.creating?.kind === 'list') && (
              <p className="px-2 py-1 text-xs text-subtle">{LISTS_EMPTY}</p>
            )}
            {data.archivedCount > 0 && (
              <div className="mt-px">
                <div className={rowShell(false, null)}>
                  <button
                    type="button"
                    aria-expanded={archivedOpen}
                    data-sidebar-row=""
                    onClick={ui.toggleArchived}
                    className={cn(ROW_MAIN, 'pl-2 text-left text-muted')}
                  >
                    {archivedOpen ? (
                      <ChevronDown size={14} className="shrink-0 text-subtle" />
                    ) : (
                      <ChevronRight size={14} className="shrink-0 text-subtle" />
                    )}
                    <span className="min-w-0 flex-1 truncate">Archived ({formatCount(data.archivedCount)})</span>
                  </button>
                </div>
                {archivedOpen &&
                  (archivedError ? (
                    <p className="py-1 pl-[44px] pr-2 text-xs text-danger">{archivedError}</p>
                  ) : archivedLists === null ? (
                    <p className="py-1 pl-[44px] pr-2 text-xs text-subtle">Loading…</p>
                  ) : (
                    <ul role="list" className="flex flex-col gap-px">
                      {archivedLists.map((l) => (
                        <ListRow key={l.id} list={l} depth={1} scopeIds={[]} folders={data.folders} active={pathname === `/lists/${l.id}`} archived />
                      ))}
                    </ul>
                  ))}
              </div>
            )}
          </>
        )}
      </section>

      <section aria-labelledby={groupsId}>
        <SectionHeader id={groupsId} title="Groups" actions={[{ label: 'New group', text: 'Group', onClick: () => ui.startCreate('group') }]} />
        {data && tree && !error && (
          <>
            <ul role="list" className="flex flex-col gap-px">
              {tree.groups.map((g) => (
                <GroupRow key={g.id} group={g} groupIds={groupIds} active={pathname === '/leads' && activeGroupId === g.id} />
              ))}
              {ui.creating?.kind === 'group' && (
                <li>
                  <NameBox placeholder="Group name" label="New group name" at={BOX_AT[0]} />
                </li>
              )}
            </ul>
            {data.groups.length === 0 && ui.creating?.kind !== 'group' && <p className="px-2 py-1 text-xs text-subtle">{GROUPS_EMPTY}</p>}
          </>
        )}
        {/* PR D adds the saved Pipeline workflows here, under Groups ("Workflows"). */}
      </section>
    </div>
  )
}
