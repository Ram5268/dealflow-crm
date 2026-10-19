'use client'

import { useCallback, useEffect, useId, useRef, useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import Link from 'next/link'
import { AlertTriangle, ChevronLeft, ChevronRight, ListOrdered, Search, Users, X, Zap } from 'lucide-react'
import {
  Badge,
  Button,
  DataTable,
  DropdownItem,
  EmptyState,
  Input,
  Select,
  Tooltip,
  useToast,
  type Column,
  type SortState,
} from '@/components/ui'
import type { AppliedGroup, AppliedSort, LeadRow } from '@/lib/leads/list'
import { cn } from '@/lib/ui/cn'
import { groupColorStyle } from '@/lib/ui/groupColors'
import { formatCount, rankedHeadline } from '@/components/lists/format'
import { BulkActionsMenu } from '@/components/lists/BulkActionsMenu'
import { SelectAllMatching } from '@/components/lists/SelectAllMatching'
import { selectAllOffer } from '@/components/lists/bulk-actions'
import { allLeadsExportUrl, getAllLeadIds } from '@/lib/core-data/lists/client'

const SEARCH_DEBOUNCE_MS = 300

function formatDate(iso: string): string {
  return new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric' }).format(new Date(iso))
}

function toCsv(rows: LeadRow[]): string {
  const head = ['Name', 'Status', 'Priority', 'Contacts', 'Source', 'Address', 'Updated']
  const esc = (v: unknown) => {
    const s = v == null ? '' : String(v)
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
  }
  const body = rows.map((r) =>
    [r.displayName, r.statusLabel, r.priorityScore, r.contactCount, r.source, r.address, r.updatedAt]
      .map(esc)
      .join(','),
  )
  return [head.join(','), ...body].join('\n')
}

export function LeadsView({
  rows,
  total,
  page,
  pageSize,
  sort,
  q,
  viewId,
  views,
  viewError,
  sequencesOffReason,
  group = null,
  groupError,
  rankedAt = null,
}: {
  rows: LeadRow[]
  total: number
  page: number
  pageSize: number
  sort: AppliedSort
  q: string
  viewId: string
  views: { id: string; name: string }[]
  viewError?: string
  /** Brief 41.2 (PR E): why "Add to sequence" is greyed out (email and texting off). */
  sequencesOffReason?: string | null
  /** Brief 45: the group the page is narrowed to (?group=), shown as a removable chip. */
  group?: AppliedGroup | null
  /** Brief 45: ?group= named a group that doesn't exist. */
  groupError?: string
  /** Brief 45: when DealFlow's morning ranking came in (rank order only). */
  rankedAt?: string | null
}) {
  const router = useRouter()
  const { toast } = useToast()
  const [pending, startTransition] = useTransition()
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [term, setTerm] = useState(q)
  const sequencesOffId = useId()

  // The search box's pending debounce, and a flag for "Clear filters", which
  // empties the box itself (that is not a new search to send).
  const searchTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const skipSearch = useRef(false)

  // Push a new query string; every filter/sort/page control funnels through
  // here so the URL stays the single source of truth and is shareable.
  const push = useCallback(
    (patch: Record<string, string | undefined>) => {
      // Every push carries the box's current text, so a search still waiting to fire would only undo it.
      clearTimeout(searchTimer.current)
      const params = new URLSearchParams()
      // A Smart View's own saved sort stays implicit (no sort in the URL), so
      // every page of the view is listed in that same order.
      const base: Record<string, string | undefined> = {
        q: term || undefined,
        viewId: viewId || undefined,
        // Brief 45: the group filter rides along (a Smart View drops it).
        group: group?.id,
        sort: sort.fromView || sort.ranked ? undefined : (sort.key ?? undefined),
        dir: sort.fromView || sort.ranked ? undefined : sort.dir,
        page: String(page),
        ...patch,
      }
      for (const [k, v] of Object.entries(base)) if (v) params.set(k, v)
      startTransition(() => router.push(`/leads?${params.toString()}`))
    },
    [router, term, viewId, sort, page, group],
  )

  // Debounce the search box so typing does not fire a query per keystroke.
  const first = useRef(true)
  useEffect(() => {
    if (first.current) {
      first.current = false
      return
    }
    if (skipSearch.current) {
      skipSearch.current = false
      return
    }
    if (term === q) return
    searchTimer.current = setTimeout(() => push({ q: term || undefined, page: '1' }), SEARCH_DEBOUNCE_MS)
    return () => clearTimeout(searchTimer.current)
    // `push` is intentionally omitted: it changes identity on every keystroke.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [term, q])

  const exportSelected = useCallback(() => {
    const chosen = rows.filter((r) => selected.has(r.id))
    if (chosen.length === 0) return
    const blob = new Blob([toCsv(chosen)], { type: 'text/csv;charset=utf-8' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `leads-${new Date().toISOString().slice(0, 10)}.csv`
    a.click()
    URL.revokeObjectURL(url)
    toast({ title: `Exported ${chosen.length} lead${chosen.length === 1 ? '' : 's'}` })
  }, [rows, selected, toast])

  // Brief 45 (PR C): a selection never outlives the search, Smart View or group
  // it was made in, so a bulk action can't reach people the list no longer
  // shows [engineering precaution: "Select all N matching" can select thousands].
  const filterKey = `${q}\u0000${viewId}\u0000${group?.id ?? ''}`
  // What "Select all N matching" and its export cover: the search box and the
  // group (?group=), exactly what this page shows [PR C review: without the
  // group, "Select all" on a group's page would select the whole CRM].
  const matching = { q: q || undefined, group: group?.id }
  const selectedFor = useRef(filterKey)
  useEffect(() => {
    if (selectedFor.current === filterKey) return
    selectedFor.current = filterKey
    setSelected(new Set())
  }, [filterKey])

  // "Select all N matching" reaches past this page through the all-leads
  // `ids=1` call, which knows the search box but not Smart Views, so it's
  // offered only without a Smart View.
  const pageIds = rows.map((r) => r.id)
  const everyoneSelected = !viewId && selectAllOffer({ pageIds, selected, total }).kind === 'all'
  const exportForMenu = useCallback(() => {
    if (!everyoneSelected) {
      // This page's rows are all the browser has: never export part of a
      // selection that reaches other pages without saying so.
      const elsewhere = selected.size - rows.filter((r) => selected.has(r.id)).length
      if (elsewhere > 0) {
        toast({
          tone: 'danger',
          title: 'Nothing exported',
          description: `${elsewhere.toLocaleString('en-US')} of the ${selected.size.toLocaleString('en-US')} selected ${elsewhere === 1 ? 'is on another page' : 'are on other pages'}. Select all matching to export everyone, or export one page at a time.`,
        })
        return
      }
      return exportSelected()
    }
    // Everyone matching is selected, most of them not on this page: the
    // ranked CSV of all of them (no phones or emails, like this export).
    const a = document.createElement('a')
    a.href = allLeadsExportUrl(matching)
    a.click()
    toast({ title: `Exporting all ${selected.size.toLocaleString('en-US')} matching leads` })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [everyoneSelected, exportSelected, filterKey, rows, selected, toast])

  const columns: Column<LeadRow>[] = [
    // Brief 45: in rank order, each person's place in All leads (the same
    // order as every list). Not shown under a Smart View or a column sort.
    ...(sort.ranked
      ? [
          {
            key: 'rank',
            header: '#',
            width: '64px',
            align: 'right' as const,
            cell: (r: LeadRow) => <span className="tabular-nums text-muted">{r.rank != null ? formatCount(r.rank) : '—'}</span>,
          },
        ]
      : []),
    {
      key: 'displayName',
      header: 'Name',
      sortable: true,
      cell: (r) => (
        <Link
          href={`/leads/${r.id}`}
          onClick={(e) => e.stopPropagation()}
          className="text-link hover:underline"
        >
          {r.displayName}
        </Link>
      ),
    },
    {
      key: 'statusLabel',
      header: 'Status',
      sortable: true,
      width: '140px',
      cell: (r) => (r.statusLabel ? <Badge>{r.statusLabel}</Badge> : <span className="text-subtle">—</span>),
    },
    {
      key: 'priorityScore',
      header: 'Priority',
      sortable: true,
      width: '90px',
      align: 'right',
      cell: (r) => (r.priorityScore ?? <span className="text-subtle">—</span>),
    },
    {
      key: 'contactCount',
      header: 'Contacts',
      width: '90px',
      align: 'right',
      cell: (r) => r.contactCount,
    },
    {
      key: 'source',
      header: 'Source',
      width: '130px',
      cell: (r) => <span className="text-muted">{r.source ?? '—'}</span>,
    },
    {
      key: 'updatedAt',
      header: 'Updated',
      sortable: true,
      width: '100px',
      cell: (r) => <span className="text-muted">{formatDate(r.updatedAt)}</span>,
    },
  ]

  const totalPages = Math.max(1, Math.ceil(total / pageSize))
  const from = total === 0 ? 0 : (page - 1) * pageSize + 1
  const to = Math.min(page * pageSize, total)

  return (
    <div className="flex h-full flex-col">
      <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-line px-4 py-2">
        <div className="w-64">
          <Input
            value={term}
            onChange={(e) => setTerm(e.target.value)}
            placeholder="Search leads…"
            leading={<Search size={13} />}
            aria-label="Search leads"
          />
        </div>

        <div className="w-52">
          <Select
            value={viewId || 'all'}
            onValueChange={(v) =>
              // Picking a view drops any column sort, so the view's own sort applies,
              // and the group filter (a Smart View has its own).
              push({ viewId: v === 'all' ? undefined : v, sort: undefined, dir: undefined, group: undefined, page: '1' })
            }
            options={[
              { value: 'all', label: 'All leads' },
              ...views.map((v) => ({ value: v.id, label: v.name })),
            ]}
          />
        </div>

        {/* Brief 45: ?group=<id> narrows All leads to one group (an older sidebar
            link; a group now opens the Pipeline on that group). */}
        {group && (
          <span className="inline-flex h-7 items-center gap-1.5 rounded-full border border-line bg-elevated pl-2.5 pr-1 text-sm text-fg">
            <span aria-hidden="true" className={cn('h-2 w-2 rounded-full', groupColorStyle(group.color).dot)} />
            {group.id === 'none' ? 'In no group' : `Group: ${group.name}`}
            <button
              type="button"
              aria-label="Remove the group filter"
              onClick={() => push({ group: undefined, page: '1' })}
              className="flex h-5 w-5 items-center justify-center rounded-full text-subtle hover:bg-hover hover:text-fg"
            >
              <X size={12} />
            </button>
          </span>
        )}

        {/* Brief 45: a column sort replaces the rank order until you come back to it. */}
        {!viewId && !sort.ranked && (
          <Button size="sm" variant="ghost" onClick={() => push({ sort: undefined, dir: undefined, page: '1' })}>
            <ListOrdered size={13} />
            Ranked order
          </Button>
        )}

        <div className="ml-auto flex items-center gap-2">
          {selected.size > 0 && (
            <>
              <span className="text-sm text-muted">{selected.size.toLocaleString('en-US')} selected</span>
              {/* Brief 45 (PR C): Add to group · Remove from group · Add to list
                  · Export CSV [brief §5.4]. Organization only; nothing here
                  contacts anyone. */}
              <BulkActionsMenu leadIds={[...selected]} onDone={() => router.refresh()} onExport={exportForMenu}>
                  {/* Sequences ship in M4; the entry is visible but inert so the
                      menu shape does not change when it goes live. */}
                  <Tooltip content={sequencesOffReason ? null : 'Sequences ship in M4'} side="left">
                    <div>
                      <DropdownItem disabled aria-describedby={sequencesOffReason ? sequencesOffId : undefined}>
                        <span className="flex items-center gap-2">
                          <Zap size={13} className="text-subtle" />
                          Add to sequence
                        </span>
                      </DropdownItem>
                    </div>
                  </Tooltip>
                  {/* Brief 41.2 (PR E): while email and texting are off, the reason
                      sits under the greyed-out entry. Greyed out with the reason,
                      not hidden, is Ryan's decision of 2026-10-17. */}
                  {sequencesOffReason && (
                    <p id={sequencesOffId} className="px-2 pb-1 text-xs text-subtle">
                      {sequencesOffReason}
                    </p>
                  )}
              </BulkActionsMenu>
            </>
          )}
          <span className="text-sm text-subtle" aria-live="polite">
            {pending ? 'Loading…' : `${from}–${to} of ${total}`}
          </span>
          {sort.ranked && !pending && (
            <span className="hidden text-sm text-subtle lg:inline" suppressHydrationWarning>
              · {rankedHeadline(rankedAt, new Date())}
            </span>
          )}
        </div>
      </div>

      {!viewId && (
        <SelectAllMatching
          pageIds={pageIds}
          selected={selected}
          total={total}
          scope={filterKey}
          onSelect={setSelected}
          loadAll={() => getAllLeadIds(matching)}
        />
      )}

      {groupError && (
        <div className="flex shrink-0 items-center gap-2 border-b border-line bg-warning-subtle px-4 py-2 text-sm text-warning">
          <AlertTriangle size={14} />
          {groupError}
        </div>
      )}

      {viewError && (
        <div className="flex shrink-0 items-center gap-2 border-b border-line bg-warning-subtle px-4 py-2 text-sm text-warning">
          <AlertTriangle size={14} />
          Smart View could not be applied: {viewError}. Showing all leads.
        </div>
      )}

      {/* Close runs the leads grid edge to edge — no card inset. */}
      <div className="min-h-0 flex-1 overflow-auto">
        <DataTable
          columns={columns}
          rows={rows}
          getRowId={(r) => r.id}
          sort={sort.key ? ({ key: sort.key, dir: sort.dir } as SortState) : undefined}
          onSortChange={(s) => push({ sort: s.key, dir: s.dir, page: '1' })}
          selectedIds={selected}
          onSelectedChange={setSelected}
          onRowActivate={(r) => router.push(`/leads/${r.id}`)}
          // Brief 45: the post-merge check reads each ranked row's place.
          rowAttributes={(r) => (r.rank != null ? { 'data-rank': r.rank } : undefined)}
          empty={
            <EmptyState
              icon={<Users />}
              title={q || viewId || group ? 'No leads match' : 'No leads yet'}
              description={
                q || viewId || group
                  ? 'Try a different search term, Smart View or group.'
                  : 'Import a Mojo CSV to get started.'
              }
              action={
                q || viewId || group ? (
                  <Button onClick={() => { if (term !== '') skipSearch.current = true; setTerm(''); push({ q: undefined, viewId: undefined, group: undefined, page: '1' }) }}>
                    Clear filters
                  </Button>
                ) : (
                  <Button variant="primary" asChild>
                    <Link href="/imports">Import CSV</Link>
                  </Button>
                )
              }
            />
          }
        />
      </div>

      {totalPages > 1 && (
        <div className="flex shrink-0 items-center justify-end gap-2 border-t border-line px-4 py-2">
          <Button
            size="sm"
            disabled={page <= 1}
            onClick={() => push({ page: String(page - 1) })}
          >
            <ChevronLeft size={13} />
            Previous
          </Button>
          <span className="text-sm text-muted">
            Page {page} of {totalPages}
          </span>
          <Button
            size="sm"
            disabled={page >= totalPages}
            onClick={() => push({ page: String(page + 1) })}
          >
            Next
            <ChevronRight size={13} />
          </Button>
        </div>
      )}
    </div>
  )
}
