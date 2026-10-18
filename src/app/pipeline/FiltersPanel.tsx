'use client'

import { CircleHelp } from 'lucide-react'
import { Button, Checkbox, Select, type SelectOption } from '@/components/ui'
import type {
  FolderDTO, ListDTO, PipelineFilterOptions, PipelineFilters, PipelineQuery,
} from '@/lib/core-data/lists/types'
import { STRONG_BUYER_MIN_FIT } from '@/lib/core-data/lists/rules'
import {
  LAST_CONTACT_OPTIONS, TASK_DUE_OPTIONS, TIER_OPTIONS, TIME_IN_GROUP_OPTIONS, UNIT_OPTIONS, type FilterOption,
} from './filters'
import { panelFilterCount } from './url'

// Radix Select can't use '' as a value, so "Any" has its own.
const ANY = '__any__'
const anyOf = (options: FilterOption[]): SelectOption[] => [{ value: ANY, label: 'Any' }, ...options]
const named = (names: readonly string[]): FilterOption[] => names.map((n) => ({ value: n, label: n }))

/**
 * The Pipeline's filters [brief §5.6]. Each change applies at once (it goes
 * into the URL). Value range isn't offered until Brief 44's estimates exist.
 */
export function FiltersPanel({
  query,
  lists,
  folders,
  archivedLists,
  filterOptions,
  onChange,
  onClear,
  onHelp,
}: {
  query: PipelineQuery
  lists: ListDTO[]
  folders: FolderDTO[]
  archivedLists: ListDTO[]
  filterOptions: PipelineFilterOptions
  onChange: (patch: Partial<PipelineFilters>) => void
  onClear: () => void
  onHelp: () => void
}) {
  const f = query.filters
  const pick = <K extends keyof PipelineFilters>(key: K) => (v: string) =>
    onChange({ [key]: v === ANY ? undefined : v } as Partial<PipelineFilters>)

  // One picker for "list or folder": a folder means any of its active lists.
  const listOptions: SelectOption[] = [{ value: ANY, label: 'Any list' }]
  for (const folder of folders) {
    listOptions.push({ value: `folder:${folder.id}`, label: `${folder.name} (every list in it)` })
    for (const l of lists.filter((x) => x.folderId === folder.id)) listOptions.push({ value: `list:${l.id}`, label: `${folder.name} › ${l.name}` })
  }
  for (const l of lists.filter((x) => x.folderId === null)) listOptions.push({ value: `list:${l.id}`, label: l.name })
  const archived = f.list ? archivedLists.find((l) => l.id === f.list) : undefined
  if (archived) listOptions.push({ value: `list:${archived.id}`, label: `${archived.name} (archived)` })
  const listValue = f.list ? `list:${f.list}` : f.folder ? `folder:${f.folder}` : ANY
  const onList = (v: string) => {
    if (v.startsWith('list:')) onChange({ list: v.slice('list:'.length), folder: undefined })
    else if (v.startsWith('folder:')) onChange({ folder: v.slice('folder:'.length), list: undefined })
    else onChange({ list: undefined, folder: undefined })
  }

  return (
    <div className="flex flex-col gap-3" data-testid="filters-panel">
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <Select
          label="List or folder"
          value={listValue}
          onValueChange={onList}
          options={listOptions}
          hint={lists.length === 0 && folders.length === 0 ? 'No lists yet.' : undefined}
        />
        <Select label="Borough" value={f.borough ?? ANY} onValueChange={pick('borough')} options={anyOf(named(filterOptions.boroughs))} />
        <Select
          label="Neighborhood"
          value={f.neighborhood ?? ANY}
          onValueChange={pick('neighborhood')}
          options={anyOf(named(filterOptions.neighborhoods))}
        />
        <Select
          label="Property type"
          value={f.propertyType ?? ANY}
          onValueChange={pick('propertyType')}
          options={anyOf(named(f.propertyType && !filterOptions.propertyTypes.includes(f.propertyType) ? [f.propertyType, ...filterOptions.propertyTypes] : filterOptions.propertyTypes))}
          hint={filterOptions.propertyTypes.length === 0 ? 'No property types in your CRM yet.' : undefined}
        />
        <Select label="Units" value={f.units ?? ANY} onValueChange={pick('units')} options={anyOf(UNIT_OPTIONS)} />
        <Select label="DealFlow tier" value={f.tier ?? ANY} onValueChange={pick('tier')} options={anyOf(TIER_OPTIONS)} />
        <Select label="Last contact" value={f.lastContact ?? ANY} onValueChange={pick('lastContact')} options={anyOf(LAST_CONTACT_OPTIONS)} />
        <Select label="Task due" value={f.taskDue ?? ANY} onValueChange={pick('taskDue')} options={anyOf(TASK_DUE_OPTIONS)} />
        <Select
          label="Time in group"
          value={f.timeInGroup ?? ANY}
          onValueChange={pick('timeInGroup')}
          options={anyOf(TIME_IN_GROUP_OPTIONS)}
        />
      </div>
      <div className="flex flex-col gap-2">
        <Checkbox
          label={`Has a strong buyer (fit ${STRONG_BUYER_MIN_FIT}+)`}
          checked={f.strongBuyer === '1'}
          onCheckedChange={(c) => onChange({ strongBuyer: c === true ? '1' : undefined })}
        />
        <Checkbox
          label="In more than one group"
          checked={f.multiGroup === '1'}
          onCheckedChange={(c) => onChange({ multiGroup: c === true ? '1' : undefined })}
        />
      </div>
      <p className="text-xs text-subtle">
        Value range: not available yet. Our value estimates aren&apos;t in the CRM until Brief 44 adds them.
      </p>
      <div className="flex items-center justify-between gap-2 border-t border-line pt-2">
        <Button size="sm" variant="ghost" onClick={onHelp}>
          <CircleHelp size={13} />
          How these filters work
        </Button>
        <Button size="sm" variant="ghost" onClick={onClear} disabled={panelFilterCount(f) === 0}>
          Clear all
        </Button>
      </div>
    </div>
  )
}
