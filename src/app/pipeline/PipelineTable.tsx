'use client'

import { useCallback, useState } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { ChevronLeft, ChevronRight, Download, SquareKanban } from 'lucide-react'
import {
  Badge, Button, DataTable, DropdownContent, DropdownItem, DropdownRoot, DropdownTrigger, EmptyState, useToast,
  type Column, type SortState,
} from '@/components/ui'
import type { PipelineQuery, PipelineRow, PipelineSortKey, PipelineTable as Table, SortDir } from '@/lib/core-data/lists/types'
import { toCsv } from '@/lib/core-data/lists/csv'
import { cn } from '@/lib/ui/cn'
import { dueText, inGroupShort, lastContactShort, shortDate, type DueTone } from './format'
import { GroupBadges } from './GroupBadges'

const TONE: Record<DueTone, string> = { danger: 'text-danger', warning: 'text-warning', muted: 'text-muted' }

/**
 * The Pipeline as a table [brief §5.6]: one row per person in the groups
 * shown (two groups = one row with both chips), in All-leads rank order by
 * default, sortable by rank, name, last contact, task due and time in group,
 * 100 rows a page. Rows can be selected for the bulk actions.
 */
export function PipelineTable({
  table,
  query,
  now,
  filtersActive,
  onSort,
  onPage,
  onClearFilters,
}: {
  table: Table
  query: PipelineQuery
  now: string
  filtersActive: boolean
  onSort: (sort: PipelineSortKey, dir: SortDir) => void
  onPage: (page: number) => void
  onClearFilters: () => void
}) {
  const router = useRouter()
  const { toast } = useToast()
  const [selected, setSelected] = useState<Set<string>>(new Set())
  // A new page or a new set of rows starts with nothing selected.
  const [rows, setRows] = useState(table.rows)
  if (rows !== table.rows) {
    setRows(table.rows)
    setSelected((s) => new Set([...s].filter((id) => table.rows.some((r) => r.leadId === id))))
  }

  const exportSelected = useCallback(() => {
    const chosen = table.rows.filter((r) => selected.has(r.leadId))
    if (chosen.length === 0) return
    // No phones or emails, like the list exports [engineering precaution].
    const csv = toCsv(
      ['Rank', 'Name', 'Address', 'Groups', 'Best buyer', 'Last contact', 'Next task', 'Task due', 'In group since'],
      chosen.map((r) => [
        r.rank, r.displayName, r.address, r.groups.map((g) => g.name).join('; '), r.bestBuyer?.name ?? '',
        r.lastContactAt ? shortDate(r.lastContactAt) : 'Never', r.nextTask?.text ?? '',
        r.nextTask?.dueDate ? shortDate(r.nextTask.dueDate) : '', shortDate(r.inGroupSince),
      ]),
    )
    const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }))
    const a = document.createElement('a')
    a.href = url
    a.download = `pipeline-${new Date().toISOString().slice(0, 10)}.csv`
    a.click()
    URL.revokeObjectURL(url)
    toast({ title: `Exported ${chosen.length} ${chosen.length === 1 ? 'person' : 'people'}` })
  }, [table.rows, selected, toast])

  const columns: Column<PipelineRow>[] = [
    {
      key: 'rank',
      header: '#',
      sortable: true,
      width: '64px',
      cell: (r) => (
        <span data-row={r.leadId} className="tabular-nums text-muted" title="Place in All leads">
          {r.rank}
        </span>
      ),
    },
    {
      key: 'name',
      header: 'Name',
      sortable: true,
      cell: (r) => (
        <div className="min-w-0 py-1">
          <Link href={`/leads/${r.leadId}`} onClick={(e) => e.stopPropagation()} className="whitespace-nowrap text-link hover:underline">
            {r.displayName}
          </Link>
          {r.address && <p className="whitespace-nowrap text-sm text-muted">{r.address}</p>}
        </div>
      ),
    },
    {
      key: 'groups',
      header: 'Groups',
      cell: (r) => (
        // Integration seam (Brief 45 PR C): <GroupChips compact> here once PR C merges.
        <span data-row-groups={r.leadId} className="flex flex-wrap gap-1">
          <GroupBadges groups={r.groups} />
        </span>
      ),
    },
    {
      key: 'bestBuyer',
      header: 'Best buyer',
      cell: (r) =>
        r.bestBuyer ? (
          <span className="flex max-w-[14rem] items-center gap-2 whitespace-nowrap">
            <span className="truncate">{r.bestBuyer.name}</span>
            {r.bestBuyer.score != null && <span className="text-muted">{r.bestBuyer.score}</span>}
            {r.bestBuyer.isTestData && <Badge>Test</Badge>}
          </span>
        ) : (
          <span className="text-subtle">—</span>
        ),
    },
    {
      key: 'lastContact',
      header: 'Last contact',
      sortable: true,
      width: '140px',
      cell: (r) => (
        <span className={cn('whitespace-nowrap', !r.lastContactAt && 'text-subtle')}>{lastContactShort(r.lastContactAt, now)}</span>
      ),
    },
    {
      key: 'taskDue',
      header: 'Next task',
      sortable: true,
      cell: (r) => {
        if (!r.nextTask) return <span className="text-subtle">—</span>
        const due = dueText(r.nextTask.dueDate, now)
        return (
          <span className="flex max-w-[15rem] items-center gap-1.5 whitespace-nowrap">
            <span className="truncate">{r.nextTask.text}</span>
            {due && <span className={cn('shrink-0 text-sm', TONE[due.tone])}>{due.label}</span>}
          </span>
        )
      },
    },
    {
      key: 'inGroupSince',
      header: 'Time in group',
      sortable: true,
      width: '140px',
      cell: (r) => <span className="whitespace-nowrap text-muted">{inGroupShort(r.inGroupSince, now)}</span>,
    },
  ]

  const totalPages = Math.max(1, Math.ceil(table.total / table.pageSize))
  const from = table.total === 0 ? 0 : (table.page - 1) * table.pageSize + 1
  const to = Math.min(table.page * table.pageSize, table.total)
  const sort: SortState = { key: query.sort ?? 'rank', dir: query.dir ?? 'asc' }

  return (
    <div data-testid="pipeline-table" className="flex min-h-0 flex-1 flex-col">
      <div className="flex shrink-0 items-center gap-2 border-b border-line px-4 py-2">
        {selected.size > 0 && (
          <>
            <span className="text-sm text-muted">{`${selected.size} selected`}</span>
            {/* Integration seam (Brief 45 PR C): <BulkActionsMenu leadIds={[...selected]} onExport={exportSelected} />
                (add to / remove from a group or list) replaces this menu once PR C merges. */}
            <DropdownRoot>
              <DropdownTrigger asChild>
                <Button size="sm">Bulk actions</Button>
              </DropdownTrigger>
              <DropdownContent align="start">
                <DropdownItem onSelect={exportSelected}>
                  <span className="flex items-center gap-2">
                    <Download size={13} className="text-subtle" />
                    Export CSV
                  </span>
                </DropdownItem>
              </DropdownContent>
            </DropdownRoot>
          </>
        )}
        <span className="ml-auto text-sm text-subtle" aria-live="polite">
          {`${from}–${to} of ${table.total}`}
        </span>
      </div>

      <div className="min-h-0 flex-1 overflow-auto">
        <DataTable
          columns={columns}
          rows={table.rows}
          getRowId={(r) => r.leadId}
          sort={sort}
          onSortChange={(s) => onSort(s.key as PipelineSortKey, s.dir)}
          selectedIds={selected}
          onSelectedChange={setSelected}
          onRowActivate={(r) => router.push(`/leads/${r.leadId}`)}
          empty={
            table.total > 0 ? (
              <EmptyState
                icon={<SquareKanban />}
                title="This page is past the end"
                description={`There are ${table.total} people here, on ${totalPages} ${totalPages === 1 ? 'page' : 'pages'}.`}
                action={<Button onClick={() => onPage(1)}>Go to page 1</Button>}
              />
            ) : (
              <EmptyState
                icon={<SquareKanban />}
                title={filtersActive ? 'No one matches these filters' : 'No one is in these groups yet'}
                description={
                  filtersActive
                    ? 'Try fewer filters, or show more groups.'
                    : "Add people to a group from their contact card, and they'll show up here."
                }
                action={filtersActive ? <Button onClick={onClearFilters}>Clear filters</Button> : undefined}
              />
            )
          }
        />
      </div>

      {totalPages > 1 && (
        <div className="flex shrink-0 items-center justify-end gap-2 border-t border-line px-4 py-2">
          <Button size="sm" disabled={table.page <= 1} onClick={() => onPage(table.page - 1)}>
            <ChevronLeft size={13} />
            Previous
          </Button>
          <span className="text-sm text-muted">{`Page ${table.page} of ${totalPages}`}</span>
          <Button size="sm" disabled={table.page >= totalPages} onClick={() => onPage(table.page + 1)}>
            Next
            <ChevronRight size={13} />
          </Button>
        </div>
      )}
    </div>
  )
}
