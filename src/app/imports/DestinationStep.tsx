'use client'

import { useId } from 'react'
import { RadioGroup } from '@/components/ui'
import { Field, controlBase, controlBorder } from '@/components/ui/Field'
import { cn } from '@/lib/ui/cn'
import type { FolderDTO, ListDTO } from '@/lib/core-data/lists/types'
import type { DestinationChoice } from '@/lib/core-data/importer/destination-form'

// Brief 45 PR F — the first step of an upload [brief §5.7]: "Where should these
// people go?" An existing list, picked from a list grouped by folder in sidebar
// order (lists outside folders last, archived lists left out), or a new list:
// a name, and a folder or "No folder" [Ryan, 2026-10-18: lists may sit
// outside folders]. Presentational: the page owns the choice and the checks.
// Native selects: keyboard and phone friendly, and the grouped picker needs
// <optgroup>, which the kit's Select doesn't have.

export interface DestinationStepProps {
  /** In sidebar order. */
  folders: Pick<FolderDTO, 'id' | 'name'>[]
  /** Active lists in sidebar order (archived ones are ignored if present). */
  lists: ListDTO[]
  value: DestinationChoice
  onChange: (next: DestinationChoice) => void
  /** The plain-English refusal (the lists API's own words), shown here. */
  error?: string | null
  disabled?: boolean
  /** The lists are still loading. */
  loading?: boolean
  /** The lists couldn't be loaded (the page says so, with "Try again"): don't claim there are none. */
  loadFailed?: boolean
}

const people = (n: number) => `${n.toLocaleString('en-US')} ${n === 1 ? 'person' : 'people'}`

export function DestinationStep({ folders, lists, value, onChange, error, disabled, loading, loadFailed }: DestinationStepProps) {
  const headingId = useId()
  const errorId = useId()
  const active = lists.filter((l) => l.archivedAt === null)
  const groups = [
    ...folders.map((f) => ({ key: f.id, label: f.name, lists: active.filter((l) => l.folderId === f.id) })),
    { key: 'none', label: 'Not in a folder', lists: active.filter((l) => l.folderId === null) },
  ].filter((g) => g.lists.length > 0)
  const noLists = !loading && active.length === 0
  const control = cn(controlBase, controlBorder(!!error), 'h-8')
  const described = error ? errorId : undefined

  return (
    <section aria-labelledby={headingId} className="space-y-3">
      <h3 id={headingId} className="text-lg font-semibold text-fg">
        Where should these people go?
      </h3>
      <RadioGroup
        value={value.mode}
        disabled={disabled}
        onValueChange={(mode) =>
          onChange(mode === 'list' ? { mode: 'list', listId: '' } : { mode: 'new', name: '', folderId: '' })
        }
        options={[
          { value: 'list', label: 'An existing list', disabled: noLists },
          { value: 'new', label: 'A new list' },
        ]}
      />
      {noLists && !loadFailed && <p className="text-xs text-subtle">No lists yet. Name a new one below.</p>}
      {value.mode === 'list' ? (
        <Field label="List" htmlFor="import-list">
          <select
            id="import-list"
            value={value.listId}
            disabled={disabled || loading}
            aria-describedby={described}
            aria-invalid={error ? true : undefined}
            onChange={(e) => onChange({ mode: 'list', listId: e.target.value })}
            className={control}
          >
            <option value="">{loading ? 'Loading your lists…' : 'Choose a list…'}</option>
            {groups.map((g) => (
              <optgroup key={g.key} label={g.label}>
                {g.lists.map((l) => (
                  <option key={l.id} value={l.id}>
                    {`${l.name} · ${people(l.memberCount)}`}
                  </option>
                ))}
              </optgroup>
            ))}
          </select>
        </Field>
      ) : (
        <div className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_minmax(0,12rem)]">
          <Field label="New list name" htmlFor="new-list-name">
            <input
              id="new-list-name"
              value={value.name}
              disabled={disabled}
              autoComplete="off"
              placeholder="e.g. Expireds – Oct 2026"
              aria-describedby={described}
              aria-invalid={error ? true : undefined}
              onChange={(e) => onChange({ ...value, name: e.target.value })}
              className={control}
            />
          </Field>
          <Field label="Folder" htmlFor="new-list-folder">
            <select
              id="new-list-folder"
              value={value.folderId}
              disabled={disabled || loading}
              onChange={(e) => onChange({ ...value, folderId: e.target.value })}
              className={cn(controlBase, controlBorder(), 'h-8')}
            >
              <option value="">No folder</option>
              {folders.map((f) => (
                <option key={f.id} value={f.id}>
                  {f.name}
                </option>
              ))}
            </select>
          </Field>
        </div>
      )}
      {error && (
        <p id={errorId} role="alert" className="text-sm text-danger">
          {error}
        </p>
      )}
    </section>
  )
}
