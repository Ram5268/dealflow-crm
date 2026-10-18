'use client'

import { useEffect, useRef, useState } from 'react'
import { Columns3, ListFilter, Search, SquareKanban, Table2 } from 'lucide-react'
import { Button, Checkbox, Input, PopoverContent, PopoverRoot, PopoverTrigger } from '@/components/ui'
import type {
  FolderDTO, GroupDTO, ListDTO, PipelineFilterOptions, PipelineFilters, PipelineQuery, PipelineView,
} from '@/lib/core-data/lists/types'
import { cn } from '@/lib/ui/cn'
import { FiltersPanel } from './FiltersPanel'
import { panelFilterCount } from './url'

const SEARCH_DEBOUNCE_MS = 300

/** Search, the filters, which groups show, and Board / Table. */
export function PipelineToolbar({
  query,
  groups,
  lists,
  folders,
  archivedLists,
  filterOptions,
  busy,
  onSearch,
  onFilters,
  onClearFilters,
  onGroups,
  onView,
  onHelp,
}: {
  query: PipelineQuery
  groups: GroupDTO[]
  lists: ListDTO[]
  folders: FolderDTO[]
  archivedLists: ListDTO[]
  filterOptions: PipelineFilterOptions
  /** A new view is loading. */
  busy: boolean
  onSearch: (q: string | undefined) => void
  onFilters: (patch: Partial<PipelineFilters>) => void
  onClearFilters: () => void
  /** undefined = every group (groups made later show up too). */
  onGroups: (ids: string[] | undefined) => void
  onView: (view: PipelineView) => void
  onHelp: () => void
}) {
  const count = panelFilterCount(query.filters)
  const [filtersOpen, setFiltersOpen] = useState(false)

  // The search box: debounced into the URL. What the URL says wins only when
  // it changed from somewhere else (a tab, "Clear all"), never mid-typing.
  const urlTerm = query.filters.q ?? ''
  const [term, setTerm] = useState(urlTerm)
  const sent = useRef(urlTerm)
  useEffect(() => {
    if (urlTerm === sent.current) return
    sent.current = urlTerm
    setTerm(urlTerm)
  }, [urlTerm])
  useEffect(() => {
    const next = term.trim()
    if (next === sent.current) return
    const t = setTimeout(() => {
      sent.current = next
      onSearch(next || undefined)
    }, SEARCH_DEBOUNCE_MS)
    return () => clearTimeout(t)
    // onSearch changes identity with every query; the term is what matters.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [term])

  return (
    <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-line px-4 py-2">
      <div className="w-full sm:w-60">
        <Input
          value={term}
          onChange={(e) => setTerm(e.target.value)}
          placeholder="Search name or address…"
          leading={<Search size={13} />}
          aria-label="Search the Pipeline"
        />
      </div>

      <PopoverRoot open={filtersOpen} onOpenChange={setFiltersOpen}>
        <PopoverTrigger asChild>
          <Button size="sm" data-testid="filters-button" aria-label={count ? `Filters, ${count} on` : 'Filters'}>
            <ListFilter size={13} />
            Filters
            {count > 0 && <span className="rounded bg-accent px-1 text-[10px] font-medium text-accent-fg">{count}</span>}
          </Button>
        </PopoverTrigger>
        <PopoverContent align="start" className="w-[min(36rem,calc(100vw-2rem))] p-3">
          <FiltersPanel
            query={query}
            lists={lists}
            folders={folders}
            archivedLists={archivedLists}
            filterOptions={filterOptions}
            onChange={onFilters}
            onClear={onClearFilters}
            onHelp={() => {
              setFiltersOpen(false)
              onHelp()
            }}
          />
        </PopoverContent>
      </PopoverRoot>

      <GroupsPicker groups={groups} shown={query.groups} label={query.view === 'board' ? 'Columns' : 'Groups'} onGroups={onGroups} />

      <div role="group" aria-label="View" className="inline-flex h-7 items-center rounded-md border border-line bg-elevated p-0.5">
        <ViewButton active={query.view === 'board'} onClick={() => onView('board')}>
          <SquareKanban size={13} />
          Board
        </ViewButton>
        <ViewButton active={query.view === 'table'} onClick={() => onView('table')}>
          <Table2 size={13} />
          Table
        </ViewButton>
      </div>

      {busy && (
        <span className="text-sm text-subtle" aria-live="polite">
          Loading…
        </span>
      )}
    </div>
  )
}

function ViewButton({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      type="button"
      aria-pressed={active}
      onClick={onClick}
      className={cn(
        'inline-flex h-full items-center gap-1 rounded px-2 text-sm transition-colors',
        active ? 'bg-active font-medium text-fg-strong' : 'text-muted hover:text-fg',
      )}
    >
      {children}
    </button>
  )
}

/** Which groups show as columns (in the table: whose people are listed). Saved with a workflow. */
function GroupsPicker({
  groups,
  shown,
  label,
  onGroups,
}: {
  groups: GroupDTO[]
  shown: string[] | undefined
  label: string
  onGroups: (ids: string[] | undefined) => void
}) {
  const on = new Set(shown ?? groups.map((g) => g.id))
  const restricted = shown !== undefined && groups.some((g) => !on.has(g.id))
  const shownCount = groups.filter((g) => on.has(g.id)).length
  const toggle = (id: string, checked: boolean) => {
    const next = groups.filter((g) => (g.id === id ? checked : on.has(g.id))).map((g) => g.id)
    onGroups(next.length === groups.length ? undefined : next)
  }
  return (
    <PopoverRoot>
      <PopoverTrigger asChild>
        <Button size="sm">
          <Columns3 size={13} />
          {restricted ? `${label} (${shownCount} of ${groups.length})` : label}
        </Button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-64">
        <p className="mb-2 text-xs font-medium text-subtle">Show these groups</p>
        <ul className="flex max-h-72 flex-col gap-1.5 overflow-y-auto">
          {groups.map((g) => (
            <li key={g.id}>
              <Checkbox
                label={g.name}
                checked={on.has(g.id)}
                // At least one: a board with no columns would be empty for no reason.
                disabled={on.has(g.id) && shownCount === 1}
                onCheckedChange={(c) => toggle(g.id, c === true)}
              />
            </li>
          ))}
        </ul>
        {restricted && (
          <Button size="sm" variant="ghost" className="mt-2" onClick={() => onGroups(undefined)}>
            Show every group
          </Button>
        )}
      </PopoverContent>
    </PopoverRoot>
  )
}
