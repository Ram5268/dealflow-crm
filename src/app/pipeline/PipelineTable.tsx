'use client'

import { useCallback, useState } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { ChevronLeft, ChevronRight, SquareKanban } from 'lucide-react'
import { Badge, Button, DataTable, EmptyState, useToast, type Column, type SortState } from '@/components/ui'
import { BulkActionsMenu } from '@/components/lists/BulkActionsMenu'
import { SelectAllMatching } from '@/components/lists/SelectAllMatching'
import { getPipelineIds } from '@/lib/core-data/lists/client'
import type { PipelineQuery, PipelineRow, PipelineSortKey, PipelineTable as Table, SortDir } from '@/lib/core-data/lists/types'
import { OurValueCell } from '@/components/lists/OurValue'
import { cn } from '@/lib/ui/cn'
import { keepSelection } from '@/app/lists/[id]/selection'
import { dueText, inGroupShort, lastContactShort, type DueTone } from './format'
import { pipelineRowsToCsv } from './csv'
import { PipelineGroupChips } from './PipelineGroupChips'
import { pipelineSearch } from './url'

const TONE: Record<DueTone, string> = { danger: 'text-danger', warning: 'text-warning', muted: 'text-muted' }

const num = (n: number) => n.toLocaleString('en-US')

/**
 * The Pipeline as a table [brief §5.6]: one row per person in the groups
 * shown (two groups = one row with both chips), in All-leads rank order by
 * default, sortable by rank, name, last contact, task due and time in group,
 * 100 rows a page. Rows can be selected for the bulk actions; Brief 50 PR 7:
 * with the whole page selected, "Select all N matching" selects everyone the
 * groups and filters show, on every page, as on list pages and All leads.
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
  // A new page, sort, search or filter starts with nothing selected; a reload
  // of the same view (after a bulk action, say) keeps whoever is still on the
  // page, as on list pages (lists/[id]/selection.ts).
  const viewKey = pipelineSearch({ query: { ...query, view: 'table', page: table.page }, workflowId: null })
  const [rows, setRows] = useState({ rows: table.rows, viewKey })
  if (rows.rows !== table.rows || rows.viewKey !== viewKey) {
    setRows({ rows: table.rows, viewKey })
    setSelected((s) => keepSelection(s, table.rows, rows.viewKey !== viewKey))
  }
  const pageIds = table.rows.map((r) => r.leadId)

  const exportSelected = useCallback(() => {
    const chosen = table.rows.filter((r) => selected.has(r.leadId))
    if (chosen.length === 0) return
    // Brief 50 PR 7: the table exports the rows it has (this page); with people
    // selected on other pages it exports nothing and says why.
    const elsewhere = selected.size - chosen.length
    if (elsewhere > 0) {
      toast({
        tone: 'danger',
        title: 'Nothing exported',
        description: `${num(elsewhere)} of the ${num(selected.size)} selected ${elsewhere === 1 ? 'is on another page' : 'are on other pages'}. The Pipeline table exports one page at a time.`,
      })
      return
    }
    // No phones or emails, and never our value estimate (csv.ts).
    const csv = pipelineRowsToCsv(chosen)
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
    // Brief 45 PR G: our value and range, shown when someone on this page has
    // one (like the list pages). Never in the CSV export (csv.ts).
    ...(table.rows.some((r) => r.value)
      ? [{ key: 'value', header: 'Our value', cell: (r: PipelineRow) => <OurValueCell value={r.value} /> }]
      : []),
    {
      key: 'groups',
      header: 'Groups',
      cell: (r) => (
        <span data-row-groups={r.leadId} className="flex flex-wrap gap-1">
          <PipelineGroupChips leadId={r.leadId} groups={r.groups} />
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
            <span className="text-sm text-muted">{`${num(selected.size)} selected`}</span>
            {/* PR C's bulk actions [brief §5.4]: Add to group · Remove from group ·
                Add to list · Export CSV. They tell the page when something
                changed, and it reloads. Nobody is deleted, and nothing contacts
                anyone [Ryan, 2026-09-24: nothing contacts a lead]. */}
            <BulkActionsMenu leadIds={[...selected]} onExport={exportSelected} />
          </>
        )}
        <span className="ml-auto text-sm text-subtle" aria-live="polite">
          {`${from}–${to} of ${table.total}`}
        </span>
      </div>

      {/* Brief 50 PR 7: everyone these groups and filters show, past this page.
          A load that finishes after the view changed is dropped. */}
      <SelectAllMatching
        pageIds={pageIds}
        selected={selected}
        total={table.total}
        scope={viewKey}
        onSelect={setSelected}
        loadAll={() => getPipelineIds(query)}
      />

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
