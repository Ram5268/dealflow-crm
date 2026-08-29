'use client'

import { useCallback, useEffect, useRef, useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import Link from 'next/link'
import { AlertTriangle, ChevronLeft, ChevronRight, Download, Search, Users, Zap } from 'lucide-react'
import {
  Badge,
  Button,
  DataTable,
  DropdownContent,
  DropdownItem,
  DropdownRoot,
  DropdownTrigger,
  EmptyState,
  Input,
  Select,
  Tooltip,
  useToast,
  type Column,
  type SortState,
} from '@/components/ui'
import type { LeadRow, LeadSortKey } from '@/lib/leads/list'

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
  sortKey,
  sortDir,
  q,
  viewId,
  views,
  viewError,
}: {
  rows: LeadRow[]
  total: number
  page: number
  pageSize: number
  sortKey: LeadSortKey
  sortDir: 'asc' | 'desc'
  q: string
  viewId: string
  views: { id: string; name: string }[]
  viewError?: string
}) {
  const router = useRouter()
  const { toast } = useToast()
  const [pending, startTransition] = useTransition()
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [term, setTerm] = useState(q)

  // Push a new query string; every filter/sort/page control funnels through
  // here so the URL stays the single source of truth and is shareable.
  const push = useCallback(
    (patch: Record<string, string | undefined>) => {
      const params = new URLSearchParams()
      const base: Record<string, string | undefined> = {
        q: term || undefined,
        viewId: viewId || undefined,
        sort: sortKey,
        dir: sortDir,
        page: String(page),
        ...patch,
      }
      for (const [k, v] of Object.entries(base)) if (v) params.set(k, v)
      startTransition(() => router.push(`/leads?${params.toString()}`))
    },
    [router, term, viewId, sortKey, sortDir, page],
  )

  // Debounce the search box so typing does not fire a query per keystroke.
  const first = useRef(true)
  useEffect(() => {
    if (first.current) {
      first.current = false
      return
    }
    if (term === q) return
    const t = setTimeout(() => push({ q: term || undefined, page: '1' }), SEARCH_DEBOUNCE_MS)
    return () => clearTimeout(t)
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

  const columns: Column<LeadRow>[] = [
    {
      key: 'displayName',
      header: 'Name',
      sortable: true,
      cell: (r) => (
        <Link
          href={`/leads/${r.id}`}
          onClick={(e) => e.stopPropagation()}
          className="font-medium text-fg hover:text-accent hover:underline"
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
            onValueChange={(v) => push({ viewId: v === 'all' ? undefined : v, page: '1' })}
            options={[
              { value: 'all', label: 'All leads' },
              ...views.map((v) => ({ value: v.id, label: v.name })),
            ]}
          />
        </div>

        <div className="ml-auto flex items-center gap-2">
          {selected.size > 0 && (
            <>
              <span className="text-sm text-muted">{selected.size} selected</span>
              <DropdownRoot>
                <DropdownTrigger asChild>
                  <Button size="sm">Bulk actions</Button>
                </DropdownTrigger>
                <DropdownContent>
                  {/* Sequences ship in M4; the entry is visible but inert so the
                      menu shape does not change when it goes live. */}
                  <Tooltip content="Sequences ship in M4" side="left">
                    <div>
                      <DropdownItem disabled>
                        <span className="flex items-center gap-2">
                          <Zap size={13} className="text-subtle" />
                          Add to sequence
                        </span>
                      </DropdownItem>
                    </div>
                  </Tooltip>
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
          <span className="text-sm text-subtle" aria-live="polite">
            {pending ? 'Loading…' : `${from}–${to} of ${total}`}
          </span>
        </div>
      </div>

      {viewError && (
        <div className="flex shrink-0 items-center gap-2 border-b border-line bg-warning-subtle px-4 py-2 text-sm text-warning">
          <AlertTriangle size={14} />
          Smart View could not be applied: {viewError}. Showing all leads.
        </div>
      )}

      <div className="min-h-0 flex-1 overflow-auto p-4">
        <DataTable
          columns={columns}
          rows={rows}
          getRowId={(r) => r.id}
          sort={{ key: sortKey, dir: sortDir } as SortState}
          onSortChange={(s) => push({ sort: s.key, dir: s.dir, page: '1' })}
          selectedIds={selected}
          onSelectedChange={setSelected}
          onRowActivate={(r) => router.push(`/leads/${r.id}`)}
          empty={
            <EmptyState
              icon={<Users />}
              title={q || viewId ? 'No leads match' : 'No leads yet'}
              description={
                q || viewId
                  ? 'Try a different search term or Smart View.'
                  : 'Import a Mojo CSV to get started.'
              }
              action={
                q || viewId ? (
                  <Button onClick={() => { setTerm(''); push({ q: undefined, viewId: undefined, page: '1' }) }}>
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
