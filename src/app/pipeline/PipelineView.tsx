'use client'

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { AlertTriangle, X } from 'lucide-react'
import { IconButton, useToast } from '@/components/ui'
import { LISTS_CHANGED_EVENT, notifyListsChanged } from '@/lib/core-data/lists/client'
import type {
  PipelineCard, PipelineColumn, PipelineFilters, PipelineQuery, PipelineResult, PipelineSortKey, PipelineView as View, SortDir,
} from '@/lib/core-data/lists/types'
import { cn } from '@/lib/ui/cn'
import {
  appendColumnPage, applyMove, boardWithPending, replaceColumn, type BoardContext, type PendingMove,
} from './board-state'
import { fetchColumnPage, moveCard, moveFailure, problemText, removeWorkflow, renameWorkflow, saveOverWorkflow, saveWorkflow } from './api'
import { createMoveQueue, createPersonQueue, type MoveQueue } from './move-queue'
import { PipelineChipApi, queuedChipApi } from './PipelineGroupChips'
import type { ChipApi } from '@/components/lists/group-chips-state'
import {
  DEFAULT_QUERY, PIPELINE_PATH, normalizeQuery, panelFilterCount, pipelineHref, pipelineSearch, sameQuery, withFilter, withFilters,
} from './url'
import { matchesWorkflow } from './workflows'
import type { PipelinePageData } from './types'
import { WorkflowTabs } from './WorkflowTabs'
import { PipelineToolbar } from './PipelineToolbar'
import { FilterChips } from './FilterChips'
import { FilterHelpDialog } from './FilterHelp'
import { PipelineBoard } from './PipelineBoard'
import { PipelineTable } from './PipelineTable'
import { EmptyPipeline } from './EmptyPipeline'

/**
 * The Pipeline page [brief §5.6]: every group as a column (or one table),
 * with filters, saved workflows as tabs, and cards that move between groups.
 *
 * The URL is the state: filters, columns, view, sort, page and the open tab.
 * The server reads it and renders the board (load.ts); a change here is a
 * navigation, so Back/Forward and bookmarks work. What the page changes on
 * its own — a moved card, "load more" — it draws at once and keeps until the
 * server sends a new board. Changes made elsewhere (the sidebar, a card's
 * group chips) reload it.
 *
 * Nothing here contacts anyone [Ryan, 2026-09-24: nothing contacts a lead]:
 * groups, workflows and the board only organize [brief §4].
 */
export function PipelineView(props: PipelinePageData) {
  const { query, workflowId, groups, workflows, now } = props
  const router = useRouter()
  const { toast } = useToast()
  const [loading, startLoading] = useTransition()

  // The server's board or table for this URL, plus what changed here since.
  const queryKey = pipelineSearch({ query, workflowId: null })
  const [result, setResult] = useState<PipelineResult | null>(props.result)
  const [received, setReceived] = useState({ result: props.result, key: queryKey })
  const [notices, setNotices] = useState(props.notices)
  // After a reload of the same view, the columns that had "Load more" pages
  // load them again (the server's board has each column's first page only).
  const [deepen, setDeepen] = useState<{ groupId: string; pages: number }[]>([])
  if (props.result !== received.result) {
    if (received.key === queryKey && result?.view === 'board') {
      setDeepen(result.columns.filter((c) => c.page > 1).map((c) => ({ groupId: c.group.id, pages: c.page })))
    }
    setReceived({ result: props.result, key: queryKey })
    setResult(props.result)
    setNotices(props.notices)
  }
  const [pending, setPending] = useState<PendingMove[]>([])
  const [loadingColumns, setLoadingColumns] = useState<ReadonlySet<string>>(new Set())
  const [helpOpen, setHelpOpen] = useState(false)
  const [announcement, setAnnouncement] = useState('')

  // The latest result and query, for callbacks that finish after an await
  // (a page that arrives after the filters changed is dropped).
  const latest = useRef(result)
  const latestKey = useRef(queryKey)
  useLayoutEffect(() => {
    latest.current = result
    latestKey.current = queryKey
  })

  const ctx: BoardContext = useMemo(() => ({ groups, filters: query.filters }), [groups, query.filters])
  const board = result?.view === 'board' ? boardWithPending(result, pending, ctx) : null
  const filtersActive = panelFilterCount(query.filters) > 0 || Boolean(query.filters.q)

  const navigate = useCallback(
    (next: PipelineQuery, how: 'push' | 'replace' = 'push') => {
      const href = pipelineHref({ query: next, workflowId })
      startLoading(() => (how === 'push' ? router.push(href, { scroll: false }) : router.replace(href, { scroll: false })))
    },
    [router, workflowId],
  )
  const refresh = useCallback(() => startLoading(() => router.refresh()), [router])

  // Our own changes tell the sidebar (its counts and Workflows) without
  // reloading this page; anyone else's change reloads it.
  const ownChange = useRef(false)
  const notifyOwn = useCallback(() => {
    ownChange.current = true
    try {
      notifyListsChanged()
    } finally {
      ownChange.current = false
    }
  }, [])
  useEffect(() => {
    const onChanged = () => {
      if (!ownChange.current) refresh()
    }
    window.addEventListener(LISTS_CHANGED_EVENT, onChanged)
    return () => window.removeEventListener(LISTS_CHANGED_EVENT, onChanged)
  }, [refresh])

  const groupName = useCallback((id: string) => groups.find((g) => g.id === id)?.name ?? 'that group', [groups])

  // Reload what's shown of a longer column after a card left or joined it:
  // its later pages shifted by one. The newest request for a column wins.
  const columnRequests = useRef(new Map<string, number>())
  const reloadColumn = useCallback(
    async (groupId: string, pages: number) => {
      const ticket = (columnRequests.current.get(groupId) ?? 0) + 1
      columnRequests.current.set(groupId, ticket)
      const key = queryKey
      try {
        let fresh: PipelineColumn | null = null
        for (let page = 1; page <= pages; page++) {
          const next = await fetchColumnPage(query, groupId, page)
          if (!next) return
          fresh = fresh ? { ...next, cards: [...fresh.cards, ...next.cards.filter((c) => !fresh!.cards.some((x) => x.leadId === c.leadId))] } : next
          if (!next.hasMore) break
        }
        if (fresh && columnRequests.current.get(groupId) === ticket && latestKey.current === key) {
          const column = fresh
          setResult((r) => (r?.view === 'board' ? replaceColumn(r, column) : r))
        }
      } catch {
        // The moved card already shows; the next reload fixes the rest.
      }
    },
    [query, queryKey],
  )

  const moveSeq = useRef(0)
  // One person's group changes — card moves and chip clicks — reach the server
  // one at a time (move-queue.ts).
  const queues = useRef<{ moves: MoveQueue; chips: ChipApi } | null>(null)
  if (!queues.current) {
    const people = createPersonQueue()
    queues.current = { moves: createMoveQueue(moveCard, people), chips: queuedChipApi(people) }
  }
  /** Resolves true when the server took the move, false when it was rolled back. */
  const move = useCallback(
    async (card: PipelineCard, fromGroupId: string, toGroupId: string): Promise<boolean> => {
      if (fromGroupId === toGroupId) return false
      const m: PendingMove = { id: ++moveSeq.current, leadId: card.leadId, fromGroupId, toGroupId, at: new Date().toISOString(), card }
      const moveCtx = ctx
      setPending((p) => [...p, m])
      const settled = await queues.current!.moves(m)
      if (settled.ok) {
        setResult((r) => (r?.view === 'board' ? applyMove(r, m, moveCtx) : r))
        setPending((p) => p.filter((x) => x.id !== m.id))
        setAnnouncement(`Moved ${card.displayName} to ${groupName(toGroupId)}.`)
        notifyOwn()
        // A reload already on its way (e.g. after a chip click) may have read
        // the board before this move landed; the page's reloads run one after
        // another, so asking for one more now means the last board has the
        // move. Longer columns load their extra pages again after it. (Quietly:
        // the board already shows the move, so it isn't dimmed meanwhile.)
        router.refresh()
        return true
      }
      // Rollback: drop the move, so the card is back where it was. A move
      // skipped because an earlier one was refused needs no second toast.
      setPending((p) => p.filter((x) => x.id !== m.id))
      if (!settled.skipped) toast(moveFailure(card.displayName, groupName(toGroupId), settled.error))
      setAnnouncement(`${card.displayName} was not moved.`)
      return false
    },
    [ctx, groupName, notifyOwn, router, toast],
  )

  useEffect(() => {
    if (deepen.length === 0) return
    setDeepen([])
    for (const c of deepen) void reloadColumn(c.groupId, c.pages)
  }, [deepen, reloadColumn])

  const loadMore = useCallback(
    async (groupId: string) => {
      const col = result?.view === 'board' ? result.columns.find((c) => c.group.id === groupId) : undefined
      if (!col) return
      setLoadingColumns((s) => new Set(s).add(groupId))
      const key = queryKey
      try {
        const next = await fetchColumnPage(query, groupId, col.page + 1)
        if (next && latestKey.current === key) setResult((r) => (r?.view === 'board' ? appendColumnPage(r, next) : r))
      } catch (err) {
        toast({ title: `Couldn't load more of ${col.group.name}`, description: problemText(err), tone: 'danger' })
      } finally {
        setLoadingColumns((s) => {
          const n = new Set(s)
          n.delete(groupId)
          return n
        })
      }
    },
    [result, query, queryKey, toast],
  )

  // Saved workflows (SavedView type 'pipeline', PR A's API).
  const active = workflows.find((w) => w.id === workflowId) ?? null
  const modified = active ? !matchesWorkflow(query, active, groups) : !sameQuery({ ...query, page: undefined }, DEFAULT_QUERY)
  const saveAs = async (name: string) => {
    const wf = await saveWorkflow(name, query)
    notifyOwn()
    startLoading(() => router.push(pipelineHref({ query, workflowId: wf.id }), { scroll: false }))
    toast({ title: `Saved “${wf.name}”`, tone: 'success' })
  }
  const update = async () => {
    if (!active) return
    try {
      const wf = await saveOverWorkflow(active.id, query)
      notifyOwn()
      refresh()
      toast({ title: `Updated “${wf.name}”`, tone: 'success' })
    } catch (err) {
      toast({ title: `Couldn't update “${active.name}”`, description: problemText(err), tone: 'danger' })
    }
  }
  const rename = async (id: string, name: string) => {
    await renameWorkflow(id, name)
    notifyOwn()
    refresh()
  }
  const remove = async (id: string) => {
    const name = workflows.find((w) => w.id === id)?.name ?? 'the workflow'
    await removeWorkflow(id)
    notifyOwn()
    // Replace, not push: Back shouldn't return to the deleted workflow's tab.
    if (id === workflowId) startLoading(() => router.replace(PIPELINE_PATH, { scroll: false }))
    else refresh()
    toast({ title: `Deleted “${name}”`, description: "Nobody's groups or lists changed." })
  }

  const setFilters = (patch: Partial<PipelineFilters>) => navigate(withFilters(query, patch))
  const clearFilters = () => navigate(normalizeQuery({ ...query, filters: {}, page: undefined }))

  if (result === null || groups.length === 0) {
    return (
      <div className="flex h-full flex-col" data-testid="pipeline">
        <Notices notices={notices} onDismiss={() => setNotices([])} />
        <EmptyPipeline
          onCreated={() => {
            notifyOwn()
            refresh()
          }}
        />
      </div>
    )
  }

  return (
    <PipelineChipApi.Provider value={queues.current.chips}>
    <div className="flex h-full min-h-0 flex-col" data-testid="pipeline">
      <WorkflowTabs
        workflows={workflows}
        workflowId={workflowId}
        modified={modified}
        onSaveAs={saveAs}
        onUpdate={update}
        onRename={rename}
        onDelete={remove}
      />
      <PipelineToolbar
        query={query}
        groups={groups}
        lists={props.lists}
        folders={props.folders}
        archivedLists={props.archivedLists}
        filterOptions={result.filterOptions}
        busy={loading}
        onSearch={(q) => navigate(withFilters(query, { q }), 'replace')}
        onFilters={setFilters}
        onClearFilters={clearFilters}
        onGroups={(ids) => navigate(normalizeQuery({ ...query, groups: ids, page: undefined }))}
        onView={(view: View) => navigate(normalizeQuery({ ...query, view, page: undefined }))}
        onHelp={() => setHelpOpen(true)}
      />
      <FilterChips
        filters={query.filters}
        names={{ lists: props.lists, archivedLists: props.archivedLists, folders: props.folders }}
        onRemove={(key) => navigate(withFilter(query, key, undefined))}
        onClear={clearFilters}
      />
      <Notices notices={notices} onDismiss={() => setNotices([])} />

      <div className={cn('flex min-h-0 flex-1 flex-col transition-opacity', loading && 'opacity-60')} aria-busy={loading || undefined}>
        {board ? (
          <PipelineBoard
            board={board}
            groups={groups}
            now={now}
            filtersActive={filtersActive}
            loadingColumns={loadingColumns}
            onMove={(card, from, to) => move(card, from, to)}
            onLoadMore={(groupId) => void loadMore(groupId)}
            onAnnounce={setAnnouncement}
          />
        ) : result.view === 'table' ? (
          <PipelineTable
            table={result}
            query={query}
            now={now}
            filtersActive={filtersActive}
            onSort={(sort: PipelineSortKey, dir: SortDir) => navigate(normalizeQuery({ ...query, sort, dir, page: undefined }))}
            onPage={(page) => navigate(normalizeQuery({ ...query, page }))}
            onClearFilters={clearFilters}
          />
        ) : null}
      </div>

      <FilterHelpDialog open={helpOpen} onOpenChange={setHelpOpen} />
      <p aria-live="polite" className="sr-only">
        {announcement}
      </p>
    </div>
    </PipelineChipApi.Provider>
  )
}

/** Plain notes about the link (a deleted group, an unknown filter, …). */
function Notices({ notices, onDismiss }: { notices: string[]; onDismiss: () => void }) {
  if (notices.length === 0) return null
  return (
    <div data-testid="pipeline-notices" className="flex shrink-0 items-start gap-2 border-b border-line bg-warning-subtle px-4 py-2 text-sm text-warning">
      <AlertTriangle size={14} className="mt-0.5 shrink-0" />
      <ul className="min-w-0 flex-1">
        {notices.map((n) => (
          <li key={n}>{n}</li>
        ))}
      </ul>
      <IconButton label="Dismiss" size="sm" tooltip={false} onClick={onDismiss} className="-my-1">
        <X size={13} />
      </IconButton>
    </div>
  )
}
