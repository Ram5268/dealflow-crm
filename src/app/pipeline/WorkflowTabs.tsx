'use client'

import { useId, useState } from 'react'
import Link from 'next/link'
import { BookmarkPlus, Ellipsis } from 'lucide-react'
import {
  Button, DropdownContent, DropdownItem, DropdownRoot, DropdownSeparator, DropdownTrigger, IconButton, Input, Modal,
} from '@/components/ui'
import { NAME_MAX, type WorkflowDTO } from '@/lib/core-data/lists/types'
import { cn } from '@/lib/ui/cn'
import { problemText } from './api'
import { PIPELINE_PATH } from './url'
import { workflowHref } from './workflows'

type Dialog = { kind: 'save' } | { kind: 'rename'; workflow: WorkflowDTO } | { kind: 'delete'; workflow: WorkflowDTO }

/**
 * Saved workflows as tabs across the top [brief §5.6]: "All groups", then
 * each saved one ("Brownstone nurtures", "Expired hot leads"). A tab opens
 * its workflow as saved. When the screen no longer matches, the page offers
 * "Update" (or "Save as workflow" on All groups). Rename with F2 on a tab or
 * the "⋯" menu; delete from the menu (only the saved tab goes; nobody's
 * groups or lists change).
 */
export function WorkflowTabs({
  workflows,
  workflowId,
  modified,
  onSaveAs,
  onUpdate,
  onRename,
  onDelete,
}: {
  workflows: WorkflowDTO[]
  workflowId: string | null
  /** The screen differs from the open workflow (or from the plain All groups view). */
  modified: boolean
  onSaveAs: (name: string) => Promise<void>
  onUpdate: () => Promise<void>
  onRename: (id: string, name: string) => Promise<void>
  onDelete: (id: string) => Promise<void>
}) {
  const active = workflows.find((w) => w.id === workflowId) ?? null
  const [dialog, setDialog] = useState<Dialog | null>(null)
  const [updating, setUpdating] = useState(false)
  const close = () => setDialog(null)

  const update = async () => {
    setUpdating(true)
    try {
      await onUpdate()
    } finally {
      setUpdating(false)
    }
  }

  return (
    <div className="flex shrink-0 flex-wrap items-center gap-x-3 gap-y-1 border-b border-line px-4 py-2">
      <nav aria-label="Saved workflows" data-testid="workflow-tabs" className="flex min-w-0 max-w-full items-center gap-1 overflow-x-auto">
        <Tab href={PIPELINE_PATH} active={workflowId === null}>
          All groups
        </Tab>
        {workflows.map((w) => (
          <Tab
            key={w.id}
            href={workflowHref(w.id)}
            active={w.id === workflowId}
            onKeyDown={(e) => {
              if (e.key === 'F2') {
                e.preventDefault()
                setDialog({ kind: 'rename', workflow: w })
              }
            }}
          >
            {w.name}
          </Tab>
        ))}
        {active && (
          <DropdownRoot>
            <DropdownTrigger asChild>
              <IconButton label={`Options for “${active.name}”`} size="sm" tooltip={false}>
                <Ellipsis size={14} />
              </IconButton>
            </DropdownTrigger>
            <DropdownContent align="start">
              <DropdownItem onSelect={() => setDialog({ kind: 'rename', workflow: active })} shortcut="F2">
                Rename…
              </DropdownItem>
              <DropdownItem disabled={!modified} onSelect={() => void update()}>
                Update with what&apos;s on screen
              </DropdownItem>
              <DropdownItem onSelect={() => setDialog({ kind: 'save' })}>Save as new…</DropdownItem>
              <DropdownSeparator />
              <DropdownItem danger onSelect={() => setDialog({ kind: 'delete', workflow: active })}>
                Delete…
              </DropdownItem>
            </DropdownContent>
          </DropdownRoot>
        )}
      </nav>

      {modified && (
        <div className="ml-auto flex flex-wrap items-center gap-2">
          {active ? (
            <>
              <span className="text-sm text-subtle">Unsaved changes</span>
              <Button size="sm" variant="primary" loading={updating} onClick={() => void update()}>
                {`Update “${active.name}”`}
              </Button>
              <Button size="sm" variant="ghost" onClick={() => setDialog({ kind: 'save' })}>
                Save as new
              </Button>
            </>
          ) : (
            <Button size="sm" onClick={() => setDialog({ kind: 'save' })}>
              <BookmarkPlus size={13} />
              Save as workflow
            </Button>
          )}
        </div>
      )}

      {dialog?.kind === 'save' && (
        <NameDialog
          title="Save as a workflow"
          description="Saves these filters, the groups shown and the board or table view as a tab. Nobody is moved or changed."
          initial=""
          submitLabel="Save"
          onSubmit={onSaveAs}
          onClose={close}
        />
      )}
      {dialog?.kind === 'rename' && (
        <NameDialog
          title="Rename workflow"
          initial={dialog.workflow.name}
          submitLabel="Rename"
          onSubmit={(name) => onRename(dialog.workflow.id, name)}
          onClose={close}
        />
      )}
      {dialog?.kind === 'delete' && <DeleteDialog workflow={dialog.workflow} onDelete={onDelete} onClose={close} />}
    </div>
  )
}

function Tab({
  href,
  active,
  children,
  onKeyDown,
}: {
  href: string
  active: boolean
  children: React.ReactNode
  onKeyDown?: (e: React.KeyboardEvent<HTMLAnchorElement>) => void
}) {
  return (
    <Link
      href={href}
      scroll={false}
      aria-current={active ? 'page' : undefined}
      onKeyDown={onKeyDown}
      className={cn(
        'flex h-7 shrink-0 items-center whitespace-nowrap rounded-md px-2.5 text-sm transition-colors',
        active ? 'bg-active font-medium text-fg-strong' : 'text-muted hover:bg-hover hover:text-fg',
      )}
    >
      {children}
    </Link>
  )
}

function NameDialog({
  title,
  description,
  initial,
  submitLabel,
  onSubmit,
  onClose,
}: {
  title: string
  description?: string
  initial: string
  submitLabel: string
  onSubmit: (name: string) => Promise<void>
  onClose: () => void
}) {
  const formId = useId()
  const [name, setName] = useState(initial)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const submit = async () => {
    if (!name.trim() || busy) return
    setBusy(true)
    setError(null)
    try {
      await onSubmit(name.trim())
      onClose()
    } catch (err) {
      setError(problemText(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Modal
      open
      onOpenChange={(o) => !o && onClose()}
      title={title}
      description={description}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" type="submit" form={formId} loading={busy} disabled={!name.trim()}>
            {submitLabel}
          </Button>
        </>
      }
    >
      <form
        id={formId}
        onSubmit={(e) => {
          e.preventDefault()
          void submit()
        }}
      >
        <Input
          label="Name"
          value={name}
          maxLength={NAME_MAX}
          autoFocus
          placeholder="e.g. Brownstone nurtures"
          error={error ?? undefined}
          onChange={(e) => {
            setName(e.target.value)
            setError(null)
          }}
        />
      </form>
    </Modal>
  )
}

function DeleteDialog({
  workflow,
  onDelete,
  onClose,
}: {
  workflow: WorkflowDTO
  onDelete: (id: string) => Promise<void>
  onClose: () => void
}) {
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const confirm = async () => {
    setBusy(true)
    setError(null)
    try {
      await onDelete(workflow.id)
      onClose()
    } catch (err) {
      setError(problemText(err))
    } finally {
      setBusy(false)
    }
  }
  return (
    <Modal
      open
      onOpenChange={(o) => !o && onClose()}
      title={`Delete “${workflow.name}”?`}
      description="Only this saved tab goes away. Nobody's groups or lists change."
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="danger" loading={busy} onClick={() => void confirm()}>
            Delete
          </Button>
        </>
      }
    >
      {error && <p className="text-sm text-danger">{error}</p>}
    </Modal>
  )
}
