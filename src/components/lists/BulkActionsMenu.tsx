'use client'

// Brief 45 PR C — the bulk actions menu for a selection of leads [brief §5.4]:
// Add to group · Remove from group · Add to list (an existing list grouped by
// folder, or a new one with a name) · Remove from this list (on a list page)
// · Export CSV. Used on All leads (LeadsView), on list pages, and in the
// Pipeline's table.
//
// Organization only: nothing here calls, texts, emails, enrolls or schedules
// anyone [Ryan, 2026-09-24]. Adding people to a group or another list never
// takes them off a list; only "Remove from this list" does [Ryan, 2026-10-18].
// Deleting is never offered: people always stay in the CRM. Selections over
// 5,000 go in chunks (bulk-actions.ts); results read in plain English.

import { Fragment, useEffect, useMemo, useRef, useState } from 'react'
import { Download, ListMinus, ListPlus, Tag, Tags } from 'lucide-react'
import {
  Button,
  DropdownContent,
  DropdownItem,
  DropdownRoot,
  DropdownSeparator,
  DropdownTrigger,
  Input,
  Modal,
  Select,
  useToast,
} from '@/components/ui'
import { createGroup, notifyListsChanged, useSidebarData } from '@/lib/core-data/lists/client'
import { nameProblem } from '@/lib/core-data/lists/rules'
import type { FolderDTO, GroupDTO, ListDTO } from '@/lib/core-data/lists/types'
import { bulkMenuEntries, peopleCount, runBulk, type BulkEntry, type BulkOp } from './bulk-actions'
import { plainError } from './group-chips-state'

export interface BulkActionsMenuProps {
  /** The selected people. Any number: more than 5,000 go in chunks. */
  leadIds: string[]
  /** On a list page: adds "Remove from this list". */
  listId?: string
  /** After a change reached the CRM (e.g. reload the rows). */
  onDone?(): void
  /** Adds "Export CSV"; the page decides what it exports. */
  onExport?(): void
  /** Entries the page puts first (Leads keeps its greyed-out "Add to sequence" there). */
  children?: React.ReactNode
}

type Action = Exclude<BulkEntry, 'export'>

const ENTRIES: Record<BulkEntry, { label: string; Icon: typeof Tag }> = {
  addToGroup: { label: 'Add to group…', Icon: Tag },
  removeFromGroup: { label: 'Remove from group…', Icon: Tags },
  addToList: { label: 'Add to list…', Icon: ListPlus },
  removeFromThisList: { label: 'Remove from this list…', Icon: ListMinus },
  export: { label: 'Export CSV', Icon: Download },
}

const num = (n: number) => n.toLocaleString('en-US')

export function BulkActionsMenu({ leadIds, listId, onDone, onExport, children }: BulkActionsMenuProps) {
  const [action, setAction] = useState<Action | null>(null)
  const entries = bulkMenuEntries({ listId, canExport: Boolean(onExport) })
  return (
    <>
      {/* Not modal: an entry opens a dialog, and a modal menu closing under it
          would fight the dialog for focus. */}
      <DropdownRoot modal={false}>
        <DropdownTrigger asChild>
          <Button size="sm">Bulk actions</Button>
        </DropdownTrigger>
        <DropdownContent>
          {children}
          {children && <DropdownSeparator />}
          {entries.map((entry) => {
            const { label, Icon } = ENTRIES[entry]
            return (
              <Fragment key={entry}>
                {entry === 'export' && <DropdownSeparator />}
                <DropdownItem onSelect={() => (entry === 'export' ? onExport?.() : setAction(entry))}>
                  <span className="flex items-center gap-2">
                    <Icon size={13} className="text-subtle" />
                    {label}
                  </span>
                </DropdownItem>
              </Fragment>
            )
          })}
        </DropdownContent>
      </DropdownRoot>
      {action && (
        <BulkDialog action={action} leadIds={leadIds} listId={listId} onDone={onDone} onClose={() => setAction(null)} />
      )}
    </>
  )
}

const DESCRIPTIONS: Record<Action, string> = {
  addToGroup: 'Pick a group. They stay on all their lists.',
  removeFromGroup: 'Pick a group. Only the label comes off; nobody is deleted.',
  addToList: 'Pick a list, or make a new one. They stay on their other lists too.',
  removeFromThisList: "They stay in the CRM, with their groups and any other lists. They only leave this list's call order.",
}

function BulkDialog({
  action,
  leadIds,
  listId,
  onDone,
  onClose,
}: {
  action: Action
  leadIds: string[]
  listId?: string
  onDone?: () => void
  onClose: () => void
}) {
  const sidebar = useSidebarData()
  const { toast } = useToast()
  const count = useMemo(() => new Set(leadIds).size, [leadIds])
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null)
  const [problem, setProblem] = useState<string | null>(null)
  const busy = progress !== null
  // Closed while a run was still working: its outcome goes to a toast instead.
  const closed = useRef(false)
  useEffect(() => {
    closed.current = false
    return () => {
      closed.current = true
    }
  }, [])

  const run = async (op: BulkOp) => {
    setProblem(null)
    setProgress({ done: 0, total: count })
    const r = await runBulk(op, leadIds, (done, total) => setProgress({ done, total }))
    setProgress(null)
    if (r.totals.added > 0 || r.totals.removed > 0 || (op.kind === 'newList' && r.listId)) {
      notifyListsChanged()
      onDone?.()
    }
    if (r.error) {
      if (closed.current) toast({ tone: 'danger', title: "The bulk action didn't finish", description: r.text })
      else setProblem(r.text)
      return
    }
    toast({ tone: 'success', title: r.text })
    onClose()
  }

  const listName = sidebar.data?.lists.find((l) => l.id === listId)?.name ?? 'this list'
  const title = {
    addToGroup: `Add ${peopleCount(count)} to a group`,
    removeFromGroup: `Remove ${peopleCount(count)} from a group`,
    addToList: `Add ${peopleCount(count)} to a list`,
    removeFromThisList: `Remove ${peopleCount(count)} from ${listName}?`,
  }[action]

  const footer =
    action === 'removeFromThisList' ? (
      <>
        <Button onClick={onClose}>Cancel</Button>
        <Button
          variant="danger"
          loading={busy}
          disabled={!listId}
          onClick={() => listId && void run({ kind: 'removeFromThisList', listId, name: listName })}
        >
          Remove from this list
        </Button>
      </>
    ) : (
      <Button onClick={onClose}>Cancel</Button>
    )

  return (
    <Modal open onOpenChange={(open) => !open && onClose()} title={title} description={DESCRIPTIONS[action]} footer={footer}>
      <div className="flex flex-col gap-3">
        {action !== 'removeFromThisList' &&
          (sidebar.data ? (
            action === 'addToList' ? (
              <>
                <ListPicker folders={sidebar.data.folders} lists={sidebar.data.lists} exclude={listId} busy={busy} onPick={(l) => void run({ kind: 'addToList', listId: l.id, name: l.name })} />
                <NewListForm folders={sidebar.data.folders} busy={busy} onSubmit={(name, folderId) => run({ kind: 'newList', name, folderId })} />
              </>
            ) : (
              <>
                <GroupPicker
                  groups={sidebar.data.groups}
                  busy={busy}
                  empty={action === 'addToGroup' ? 'No groups yet. Make one below.' : 'No groups yet.'}
                  onPick={(g) => void run({ kind: action, groupId: g.id, name: g.name })}
                />
                {action === 'addToGroup' && (
                  <NewGroupForm
                    busy={busy}
                    onSubmit={async (name) => {
                      const { group } = await createGroup({ name })
                      notifyListsChanged()
                      await run({ kind: 'addToGroup', groupId: group.id, name: group.name })
                    }}
                  />
                )}
              </>
            )
          ) : sidebar.error ? (
            <p className="text-sm text-danger">
              {sidebar.error}{' '}
              <button type="button" onClick={() => void sidebar.reload()} className="text-link hover:underline">
                Try again
              </button>
            </p>
          ) : (
            <p className="text-sm text-subtle">Loading your groups and lists…</p>
          ))}
        {progress && (
          <p className="text-sm text-muted" role="status">
            Working… {num(progress.done)} of {num(progress.total)} done
          </p>
        )}
        {problem && (
          <p className="text-sm text-danger" role="alert">
            {problem}
          </p>
        )}
      </div>
    </Modal>
  )
}

const ROW =
  'flex h-8 w-full items-center justify-between gap-3 rounded-md px-2 text-left text-sm text-fg transition-colors duration-100 hover:bg-hover disabled:cursor-not-allowed disabled:opacity-50'

function GroupPicker({
  groups,
  busy,
  empty,
  onPick,
}: {
  groups: GroupDTO[]
  busy: boolean
  empty: string
  onPick: (g: GroupDTO) => void
}) {
  if (groups.length === 0) return <p className="text-sm text-muted">{empty}</p>
  return (
    <ul className="flex max-h-64 flex-col gap-0.5 overflow-y-auto" aria-label="Groups">
      {groups.map((g) => (
        <li key={g.id}>
          <button type="button" disabled={busy} onClick={() => onPick(g)} className={ROW}>
            <span className="truncate">{g.name}</span>
            <span className="shrink-0 text-xs text-subtle" title={`${peopleCount(g.memberCount)} in it now`}>
              {num(g.memberCount)}
            </span>
          </button>
        </li>
      ))}
    </ul>
  )
}

function ListPicker({
  folders,
  lists,
  exclude,
  busy,
  onPick,
}: {
  folders: FolderDTO[]
  lists: ListDTO[]
  exclude?: string
  busy: boolean
  onPick: (l: ListDTO) => void
}) {
  // Folders in sidebar order, then the lists outside any folder.
  const sections = [
    ...folders.map((f) => ({ key: f.id, title: f.name, lists: lists.filter((l) => l.folderId === f.id && l.id !== exclude) })),
    { key: 'none', title: 'No folder', lists: lists.filter((l) => l.folderId === null && l.id !== exclude) },
  ].filter((s) => s.lists.length > 0)
  if (sections.length === 0) return <p className="text-sm text-muted">No lists yet. Make one below.</p>
  return (
    <div className="flex max-h-64 flex-col gap-2 overflow-y-auto">
      {sections.map((s) => (
        <div key={s.key}>
          <p className="px-2 pb-0.5 text-xs font-medium text-subtle">{s.title}</p>
          <ul className="flex flex-col gap-0.5" aria-label={s.title}>
            {s.lists.map((l) => (
              <li key={l.id}>
                <button type="button" disabled={busy} onClick={() => onPick(l)} className={ROW}>
                  <span className="truncate">{l.name}</span>
                  <span className="shrink-0 text-xs text-subtle" title={`${peopleCount(l.memberCount)} on it now`}>
                    {num(l.memberCount)}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </div>
      ))}
    </div>
  )
}

function NewGroupForm({ busy, onSubmit }: { busy: boolean; onSubmit: (name: string) => Promise<void> }) {
  const [name, setName] = useState('')
  const [error, setError] = useState<string | null>(null)
  // Making the group comes before the bulk run starts (`busy`): a second
  // click meanwhile would try to make it twice.
  const [creating, setCreating] = useState(false)
  const working = busy || creating
  return (
    <form
      className="flex items-end gap-2 border-t border-line pt-3"
      onSubmit={async (e) => {
        e.preventDefault()
        if (working) return
        const problem = nameProblem(name)
        if (problem) return setError(problem)
        setCreating(true)
        try {
          await onSubmit(name)
        } catch (err) {
          setError(plainError(err).message)
        } finally {
          setCreating(false)
        }
      }}
    >
      <div className="min-w-0 flex-1">
        <Input
          label="Or make a new group"
          value={name}
          onChange={(e) => {
            setName(e.target.value)
            setError(null)
          }}
          placeholder="Group name, e.g. Hot"
          error={error ?? undefined}
          readOnly={working}
        />
      </div>
      <Button type="submit" variant="primary" loading={creating} disabled={working || !name.trim()}>
        Make it and add them
      </Button>
    </form>
  )
}

const NO_FOLDER = '__none__'

function NewListForm({
  folders,
  busy,
  onSubmit,
}: {
  folders: FolderDTO[]
  busy: boolean
  onSubmit: (name: string, folderId: string | null) => Promise<void>
}) {
  const [name, setName] = useState('')
  const [folderId, setFolderId] = useState(NO_FOLDER)
  const [error, setError] = useState<string | null>(null)
  return (
    <form
      className="flex flex-wrap items-end gap-2 border-t border-line pt-3"
      onSubmit={async (e) => {
        e.preventDefault()
        const problem = nameProblem(name)
        if (problem) return setError(problem)
        await onSubmit(name, folderId === NO_FOLDER ? null : folderId)
      }}
    >
      <div className="min-w-[10rem] flex-1">
        <Input
          label="Or make a new list"
          value={name}
          onChange={(e) => {
            setName(e.target.value)
            setError(null)
          }}
          placeholder="List name"
          error={error ?? undefined}
          disabled={busy}
        />
      </div>
      <div className="w-40">
        <Select
          label="Folder"
          value={folderId}
          onValueChange={setFolderId}
          disabled={busy}
          options={[{ value: NO_FOLDER, label: 'No folder' }, ...folders.map((f) => ({ value: f.id, label: f.name }))]}
        />
      </div>
      <Button type="submit" variant="primary" disabled={busy || !name.trim()}>
        Make the list
      </Button>
    </form>
  )
}
