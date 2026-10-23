'use client'

import { createContext, useCallback, useContext, useEffect, useId, useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import { Pencil, Plus, X } from 'lucide-react'
import { Badge, Button, IconButton, Input, Kbd, useToast } from '@/components/ui'
import { isEditableTarget } from '@/lib/ui/hotkeys'
import {
  buildLeadEditPayload,
  draftFromInitial,
  leadEditKeyAction,
  type DraftRow,
  type EditKeyContext,
  type LeadEditDraft,
  type LeadEditInitial,
} from './lead-edit-state'

/**
 * Brief 50 PR 5 — the lead page's Edit mode (item 6.5): the name, status,
 * address, and each contact's phones and emails. The page stays as it is
 * while you edit; the form opens above it. DealFlow's values (priority, our
 * value estimate, property facts, buyer matches) aren't in the form: they come
 * from DealFlow. Saving calls PUT /api/leads/[id], which writes one timeline
 * entry for the save; then the page reloads its data. Nothing here contacts
 * the lead.
 *
 * Keys: "e" opens it (when you're not typing), Esc cancels, ⌘/Ctrl+Enter
 * saves (listed in the shortcuts sheet).
 */

interface LeadEditState {
  initial: LeadEditInitial
  statusOptions: string[]
  editing: boolean
  start: () => void
  stop: () => void
  buttonRef: React.RefObject<HTMLButtonElement | null>
}

const LeadEditContext = createContext<LeadEditState | null>(null)

function useLeadEdit(): LeadEditState {
  const ctx = useContext(LeadEditContext)
  if (!ctx) throw new Error('EditLeadButton and LeadEditPanel must be inside <LeadEditMode>')
  return ctx
}

/** Where a key press happened, for leadEditKeyAction. */
function keyContext(target: EventTarget | null, editing: boolean): EditKeyContext {
  const el = target instanceof Element ? target : null
  const nothingFocused = !el || el === document.body || el === document.documentElement
  return {
    editing,
    editable: isEditableTarget(target),
    inDialog: !!el?.closest('[role="dialog"], [role="alertdialog"], [role="menu"], [role="listbox"]'),
    onPage: nothingFocused || !!el?.closest('[data-contact-card="page"]'),
  }
}

/**
 * Holds whether the lead is being edited. It's the lead page's outer element
 * (a div, given the page's own attributes), so the Edit button in the header
 * and the form below it share that.
 */
export function LeadEditMode({
  initial,
  statusOptions,
  children,
  ...div
}: {
  initial: LeadEditInitial
  statusOptions: string[]
} & React.HTMLAttributes<HTMLDivElement>) {
  const [editing, setEditing] = useState(false)
  const buttonRef = useRef<HTMLButtonElement>(null)
  const start = useCallback(() => setEditing(true), [])
  const stop = useCallback(() => {
    setEditing(false)
    // Focus goes back where the editor was opened from.
    requestAnimationFrame(() => buttonRef.current?.focus())
  }, [])

  useEffect(() => {
    if (editing) return
    const onKeyDown = (e: KeyboardEvent) => {
      if (leadEditKeyAction(e, keyContext(e.target, false)) !== 'edit') return
      e.preventDefault()
      setEditing(true)
    }
    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  }, [editing])

  return (
    <LeadEditContext.Provider value={{ initial, statusOptions, editing, start, stop, buttonRef }}>
      <div {...div}>{children}</div>
    </LeadEditContext.Provider>
  )
}

export function EditLeadButton() {
  const { editing, start, buttonRef } = useLeadEdit()
  return (
    <Button ref={buttonRef} onClick={start} disabled={editing} aria-keyshortcuts="e" title="Edit this lead (e)">
      <Pencil size={13} />
      Edit
    </Button>
  )
}

/** The form, while editing; nothing otherwise. */
export function LeadEditPanel() {
  const { initial, statusOptions, editing, stop } = useLeadEdit()
  if (!editing) return null
  return <LeadEditForm initial={initial} statusOptions={statusOptions} onDone={stop} />
}

function LeadEditForm({
  initial,
  statusOptions,
  onDone,
}: {
  initial: LeadEditInitial
  statusOptions: string[]
  onDone: () => void
}) {
  const router = useRouter()
  const { toast } = useToast()
  // What the form was opened from. A page refresh that lands while it's open
  // (e.g. the one after the last save) changes `initial`, but the draft was
  // made from this, so the changes are worked out against it.
  const [base] = useState(initial)
  const [draft, setDraft] = useState<LeadEditDraft>(() => draftFromInitial(base))
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({})
  const busy = useRef(false)

  const save = useCallback(async () => {
    if (busy.current) return
    const { payload, fieldKeys } = buildLeadEditPayload(base, draft)
    if (!payload) {
      toast({ title: 'Nothing to save' })
      onDone()
      return
    }
    busy.current = true
    setSaving(true)
    setError(null)
    setFieldErrors({})
    try {
      const res = await fetch(`/api/leads/${encodeURIComponent(base.leadId)}`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
      })
      const body = await res.json().catch(() => ({}))
      if (!res.ok) {
        const message = typeof body?.error === 'string' ? body.error : `Couldn't save (error ${res.status}). Try again.`
        setError(message)
        const key = typeof body?.field === 'string' ? fieldKeys[body.field] : undefined
        if (key) setFieldErrors({ [key]: message })
        return
      }
      const changes: string[] = Array.isArray(body?.changes) ? body.changes : []
      toast(
        changes.length
          ? { tone: 'success', title: 'Lead saved', description: changes.join(' · ') }
          : { title: 'Nothing changed' },
      )
      onDone()
      router.refresh()
    } catch {
      setError("Couldn't reach the CRM. Check the connection and try again.")
    } finally {
      busy.current = false
      setSaving(false)
    }
  }, [base, draft, onDone, router, toast])

  // Esc and ⌘/Ctrl+Enter work from anywhere on the page while the form is
  // open. Esc waits while a save is on its way, so its answer isn't lost.
  const latestSave = useRef(save)
  useEffect(() => {
    latestSave.current = save
  }, [save])
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      const action = leadEditKeyAction(e, keyContext(e.target, true))
      if (!action) return
      e.preventDefault()
      if (action === 'save') void latestSave.current()
      else if (!busy.current) onDone()
    }
    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  }, [onDone])

  return (
    <LeadEditFormView
      draft={draft}
      statusOptions={statusOptions}
      saving={saving}
      error={error}
      fieldErrors={fieldErrors}
      onChange={setDraft}
      onSave={() => void save()}
      onCancel={onDone}
    />
  )
}

let nextRowKey = 0
const newRowKey = () => `new-${++nextRowKey}`

/** The form itself (no state, so it renders in tests). */
export function LeadEditFormView({
  draft,
  statusOptions,
  saving,
  error,
  fieldErrors,
  onChange,
  onSave,
  onCancel,
}: {
  draft: LeadEditDraft
  statusOptions: string[]
  saving: boolean
  error: string | null
  /** Form field or row key → the API's message about it. */
  fieldErrors: Record<string, string>
  onChange: (draft: LeadEditDraft) => void
  onSave: () => void
  onCancel: () => void
}) {
  const id = useId()
  const setRows = (contactId: string, kind: 'phones' | 'emails', rows: DraftRow[]) =>
    onChange({ ...draft, contacts: draft.contacts.map((c) => (c.id === contactId ? { ...c, [kind]: rows } : c)) })

  return (
    <form
      aria-label="Edit lead"
      noValidate // the API checks every field and says what's wrong in plain words
      onSubmit={(e) => {
        e.preventDefault()
        onSave()
      }}
      className="mb-4 rounded-lg border border-line bg-elevated"
    >
      <h2 className="rounded-t-lg bg-active px-3 py-2 text-xs font-medium text-muted">Edit lead</h2>
      <div className="flex flex-col gap-3 px-3 py-3">
        <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
          <Input
            id={`${id}-name`}
            label="Name"
            value={draft.displayName}
            onChange={(e) => onChange({ ...draft, displayName: e.target.value })}
            error={fieldErrors.displayName}
            autoFocus
            autoComplete="off"
          />
          <Input
            id={`${id}-status`}
            label="Status"
            list={`${id}-statuses`}
            value={draft.statusLabel}
            onChange={(e) => onChange({ ...draft, statusLabel: e.target.value })}
            error={fieldErrors.statusLabel}
            hint="Pick a status in use, or type a new one."
            autoComplete="off"
          />
          <datalist id={`${id}-statuses`}>
            {statusOptions.map((s) => (
              <option key={s} value={s} />
            ))}
          </datalist>
          <div className="md:col-span-2">
            <Input
              id={`${id}-address`}
              label="Address"
              value={draft.primaryAddressFull}
              onChange={(e) => onChange({ ...draft, primaryAddressFull: e.target.value })}
              error={fieldErrors.primaryAddressFull}
              placeholder="100 Example St, Brooklyn, NY 11201"
              autoComplete="off"
            />
          </div>
        </div>

        {draft.contacts.length === 0 ? (
          <p className="text-sm text-subtle">
            This lead has no contact, so there&apos;s nowhere to keep phones and emails yet.
          </p>
        ) : (
          draft.contacts.map((c) => (
            <div
              key={c.id}
              role="group"
              aria-labelledby={`${id}-${c.id}`}
              className="flex flex-col gap-3 border-t border-line pt-3"
            >
              <p id={`${id}-${c.id}`} className="text-sm font-medium text-fg">
                {c.displayName}
              </p>
              <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
                <RowList
                  title="Phones"
                  noun="phone"
                  rows={c.phones}
                  fieldErrors={fieldErrors}
                  lockedLabel="Texts blocked"
                  inputProps={{ type: 'tel', inputMode: 'tel', placeholder: '212-555-0123' }}
                  onRows={(rows) => setRows(c.id, 'phones', rows)}
                />
                <RowList
                  title="Emails"
                  noun="email"
                  rows={c.emails}
                  fieldErrors={fieldErrors}
                  lockedLabel="Opted out"
                  inputProps={{ type: 'email', inputMode: 'email', placeholder: 'name@example.com' }}
                  onRows={(rows) => setRows(c.id, 'emails', rows)}
                />
              </div>
            </div>
          ))
        )}

        <p className="text-xs text-subtle">
          Priority, our value estimate, property facts and buyer matches come from DealFlow and can&apos;t be changed
          here. Opted-out numbers and emails stay on the lead.
        </p>

        {error && (
          <p role="alert" className="text-sm text-danger">
            {error}
          </p>
        )}

        <div className="flex flex-wrap items-center gap-2">
          <Button type="submit" variant="primary" loading={saving} aria-keyshortcuts="Control+Enter Meta+Enter">
            Save
          </Button>
          <Button type="button" variant="ghost" onClick={onCancel} disabled={saving} aria-keyshortcuts="Escape">
            Cancel
          </Button>
          <span className="flex flex-wrap items-center gap-1 text-xs text-subtle">
            <Kbd>⌘/Ctrl</Kbd>
            <Kbd>Enter</Kbd>
            <span>to save ·</span>
            <Kbd>Esc</Kbd>
            <span>to cancel</span>
          </span>
        </div>
      </div>
    </form>
  )
}

function RowList({
  title,
  noun,
  rows,
  fieldErrors,
  lockedLabel,
  inputProps,
  onRows,
}: {
  title: string
  noun: 'phone' | 'email'
  rows: DraftRow[]
  fieldErrors: Record<string, string>
  lockedLabel: string
  inputProps: React.InputHTMLAttributes<HTMLInputElement>
  onRows: (rows: DraftRow[]) => void
}) {
  // A row added with "Add phone"/"Add email" takes the focus, so the keyboard flow goes on.
  const [added, setAdded] = useState<string | null>(null)
  return (
    <div className="flex min-w-0 flex-col gap-1.5">
      <p className="text-xs font-medium text-muted">{title}</p>
      {rows.length === 0 && <p className="text-sm text-subtle">No {noun}s.</p>}
      {rows.map((r, i) => (
        <div key={r.key} className="flex items-start gap-1.5">
          <div className="min-w-0 flex-1">
            <Input
              {...inputProps}
              aria-label={`${title.slice(0, -1)} ${i + 1}`}
              value={r.value}
              readOnly={r.locked}
              onChange={(e) => onRows(rows.map((x) => (x.key === r.key ? { ...x, value: e.target.value } : x)))}
              error={fieldErrors[r.key]}
              autoFocus={r.key === added}
              autoComplete="off"
            />
          </div>
          {r.locked ? (
            <Badge tone="warning" className="mt-1 shrink-0">
              {lockedLabel}
            </Badge>
          ) : (
            <IconButton
              label={`Remove this ${noun}`}
              tooltip={false}
              onClick={() => onRows(rows.filter((x) => x.key !== r.key))}
            >
              <X size={14} />
            </IconButton>
          )}
        </div>
      ))}
      <div>
        <Button
          type="button"
          size="sm"
          variant="ghost"
          onClick={() => {
            const key = newRowKey()
            setAdded(key)
            onRows([...rows, { key, value: '', locked: false }])
          }}
        >
          <Plus size={13} />
          Add {noun}
        </Button>
      </div>
    </div>
  )
}
