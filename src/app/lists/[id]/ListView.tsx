'use client'

// Brief 45 — one list's page (brief §5.4): one view, always ranked [Ryan,
// 2026-10-18]. Search and filters narrow it but keep its order and everyone's
// rank number (their place in the whole list). 100 rows a page. The server
// page reads (getRankedPage); this component filters, selects, exports and
// unarchives. "Start calling this list" is always greyed out with its reason:
// "Calling is off" while calling is off [Ryan, 2026-09-24: nothing contacts a
// lead]; while it's on, calling a whole list is a later brief (brief §5.10:
// select-and-call and the calling cockpit are out of scope), so it never
// links to the dialer.
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { useCallback, useEffect, useId, useRef, useState, useTransition } from 'react'
import { AlertTriangle, Archive, Check, ChevronLeft, ChevronRight, Download, ListX, Phone, Search } from 'lucide-react'
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
} from '@/components/ui'
import { cn } from '@/lib/ui/cn'
import { groupColorStyle } from '@/lib/ui/groupColors'
import { BOROUGHS, type BestBuyerDTO, type CallingWindowDTO, type GroupChipDTO, type MemberFilters, type RankedPage, type RankedRow } from '@/lib/core-data/lists/types'
import { LISTS_CHANGED_EVENT, listExportUrl, notifyListsChanged, updateList } from '@/lib/core-data/lists/client'
import { timezoneLabel } from '@/lib/core-data/dealflow-sync/labels'
import { formatCount, localTimeInfo, rankBadge, rankedHeadline, sourceLine } from '@/components/lists/format'
import { downloadText, messageOf } from '@/components/lists/browser'
import { listSearchString } from './filters'
import { rowsToCsv, selectedCsvFilename } from './csv'
import { keepSelection } from './selection'

const SEARCH_DEBOUNCE_MS = 300

/** The browser's clock (for local times), read after the page loads so the server and browser agree. */
function useClock(fixed?: string): Date | null {
  const [now, setNow] = useState<Date | null>(fixed ? new Date(fixed) : null)
  useEffect(() => {
    if (fixed) return
    setNow(new Date())
    const id = setInterval(() => setNow(new Date()), 60_000)
    return () => clearInterval(id)
  }, [fixed])
  return now
}

// ─── Cells ────────────────────────────────────────────────────────────────────

/** Why now, or why this person isn't ranked (they sit at the bottom). */
function WhyNowCell({ row }: { row: RankedRow }) {
  const badge = rankBadge(row)
  if (badge) {
    return (
      <Tooltip content={badge.help}>
        <span
          className={cn(
            'inline-flex h-5 items-center whitespace-nowrap rounded-full px-2 text-xs',
            row.rankState === 'scoring' ? 'bg-accent-subtle text-accent' : 'bg-active text-muted',
          )}
        >
          {badge.label}
        </span>
      </Tooltip>
    )
  }
  return row.whyNow ? <span className="line-clamp-2 min-w-[180px] text-sm">{row.whyNow}</span> : <span className="text-subtle">—</span>
}

function BestBuyerCell({ buyer }: { buyer: BestBuyerDTO | null }) {
  if (!buyer) return <span className="text-subtle">—</span>
  return (
    <span className="flex w-[220px] min-w-0 items-center gap-1.5 whitespace-nowrap text-sm">
      <span className="min-w-0 truncate" title={buyer.name}>
        {buyer.name}
      </span>
      {buyer.score != null && <span className="shrink-0 tabular-nums text-muted">{buyer.score}</span>}
      {buyer.isTestData && <Badge className="shrink-0">Test</Badge>}
    </span>
  )
}

/** Read-only group badges, in sidebar order. PR C swaps these for <GroupChips compact> (click to add/remove). */
function GroupBadges({ groups }: { groups: GroupChipDTO[] }) {
  if (groups.length === 0) return <span className="text-subtle">—</span>
  return (
    <span className="flex flex-wrap gap-1">
      {groups.map((g) => (
        <span key={g.id} className={cn('inline-flex h-5 items-center whitespace-nowrap rounded-full px-2 text-xs', groupColorStyle(g.color).chip)}>
          {g.name}
        </span>
      ))}
    </span>
  )
}

/**
 * The lead's local time and a dot for inside / outside calling hours. Never
 * "OK to call"; "(not confirmed yet)" while the window is unconfirmed
 * [engineering precaution: no compliance claim]. Before the browser clock is
 * read it shows only the zone.
 */
function LocalTimeCell({ timezone, window, now }: { timezone: string | null; window: CallingWindowDTO | undefined; now: Date | null }) {
  if (!timezone) return <span className="text-subtle">—</span>
  const info = now ? localTimeInfo(timezone, window, now) : null
  if (!info) return <span className="text-sm text-muted">{timezoneLabel(timezone)}</span>
  return (
    <span className="inline-flex items-center gap-1.5 whitespace-nowrap text-sm">
      <Tooltip content={info.label}>
        <span
          role="img"
          aria-label={info.label}
          className={cn('inline-block h-2 w-2 shrink-0 rounded-full', info.inside ? 'bg-success' : 'bg-line-strong')}
        />
      </Tooltip>
      <span className="tabular-nums">{info.time}</span>
      <span className="text-subtle">{info.zone}</span>
    </span>
  )
}

// ─── Header pieces ────────────────────────────────────────────────────────────

/** Why "Start calling this list" is greyed out while calling is on (brief §5.10: out of scope here). */
export const CALL_LIST_LATER = 'Calling a whole list comes in a later update.'

function StartCalling({ callingOffReason }: { callingOffReason: string | null }) {
  const id = useId()
  const reason = callingOffReason ?? CALL_LIST_LATER
  // Greyed out with the reason underneath, not hidden (as on the lead page).
  return (
    <div className="flex flex-col items-end gap-0.5">
      <Button variant="primary" disabled aria-describedby={id}>
        <Phone size={13} />
        Start calling this list
      </Button>
      <p id={id} className="text-xs text-subtle">
        {reason}
      </p>
    </div>
  )
}

/** A filter that's on or off ("Has a strong buyer", "Called today"). */
function FilterToggle({
  label, pressed, onToggle, disabledReason, help,
}: {
  label: string
  pressed: boolean
  onToggle: () => void
  disabledReason?: string | null
  help?: string
}) {
  const id = useId()
  const button = (
    <button
      type="button"
      aria-pressed={pressed}
      disabled={Boolean(disabledReason)}
      aria-describedby={disabledReason ? id : undefined}
      onClick={onToggle}
      className={cn(
        'inline-flex h-8 shrink-0 items-center gap-1 rounded-md border px-2.5 text-sm font-medium transition-colors',
        'disabled:cursor-not-allowed disabled:opacity-50',
        pressed ? 'border-accent bg-accent-subtle text-accent' : 'border-line bg-elevated text-fg hover:bg-hover',
      )}
    >
      {pressed && <Check size={12} />}
      {label}
    </button>
  )
  return (
    <span className="inline-flex items-center gap-1.5">
      {help && !disabledReason ? <Tooltip content={help}>{button}</Tooltip> : button}
      {disabledReason && (
        <span id={id} className="text-xs text-subtle">
          {disabledReason}
        </span>
      )}
    </span>
  )
}

// ─── The page ─────────────────────────────────────────────────────────────────

export interface ListViewProps {
  /** One page of the list, from getRankedPage (its `list` is set). */
  data: RankedPage
  /** Every group, in sidebar order (the group filter's options). */
  groups: GroupChipDTO[]
  /** The filters in the URL. */
  filters: MemberFilters
  /** Draw local times at this instant (tests); normally the browser clock after load. */
  now?: string
}

export function ListView({ data, groups, filters, now: fixedNow }: ListViewProps) {
  const list = data.list!
  const router = useRouter()
  const { toast } = useToast()
  const [pending, startTransition] = useTransition()
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [term, setTerm] = useState(filters.q ?? '')
  const [unarchiving, setUnarchiving] = useState(false)
  const now = useClock(fixedNow)
  const archived = list.archivedAt !== null
  const unknownGroup = Boolean(filters.group && filters.group !== 'none' && !groups.some((g) => g.id === filters.group))

  // A refresh (a rename or a group change elsewhere fires crm:lists-changed)
  // keeps what's picked, minus anyone no longer on the page; a new search,
  // filter or page starts with nothing picked.
  const viewKey = listSearchString(filters, data.page)
  const lastViewKey = useRef(viewKey)
  useEffect(() => {
    const viewChanged = lastViewKey.current !== viewKey
    lastViewKey.current = viewKey
    setSelected((picked) => keepSelection(picked, data.rows, viewChanged))
  }, [data, viewKey])

  // A rename, archive or group change elsewhere (the sidebar) shows here too.
  useEffect(() => {
    const refresh = () => router.refresh()
    window.addEventListener(LISTS_CHANGED_EVENT, refresh)
    return () => window.removeEventListener(LISTS_CHANGED_EVENT, refresh)
  }, [router])

  // The search box's pending debounce, and a flag for "Clear filters", which
  // empties the box itself (that is not a new search to send).
  const searchTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const skipSearch = useRef(false)

  const push = useCallback(
    (patch: Partial<MemberFilters>, page = 1) => {
      // Every push carries the box's current text, so a search still waiting to fire would only undo it.
      clearTimeout(searchTimer.current)
      const next: MemberFilters = { ...filters, q: term.trim() || undefined, ...patch }
      startTransition(() => router.push(`/lists/${encodeURIComponent(list.id)}${listSearchString(next, page)}`))
    },
    [filters, term, list.id, router],
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
    if (term.trim() === (filters.q ?? '')) return
    searchTimer.current = setTimeout(() => push({ q: term.trim() || undefined }), SEARCH_DEBOUNCE_MS)
    return () => clearTimeout(searchTimer.current)
    // `push` is intentionally omitted: it changes identity on every keystroke.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [term])

  const clearFilters = () => {
    clearTimeout(searchTimer.current)
    if (term !== '') skipSearch.current = true
    setTerm('')
    startTransition(() => router.push(`/lists/${encodeURIComponent(list.id)}`))
  }

  const exportSelected = useCallback(() => {
    const chosen = data.rows.filter((r) => selected.has(r.leadId))
    if (chosen.length === 0) return
    downloadText(rowsToCsv(chosen), selectedCsvFilename(list.name))
    toast({ title: `Exported ${chosen.length} ${chosen.length === 1 ? 'person' : 'people'}` })
  }, [data.rows, selected, list.name, toast])

  const unarchive = async () => {
    setUnarchiving(true)
    try {
      await updateList(list.id, { archived: false })
      toast({ title: `“${list.name}” is back in your lists` })
      notifyListsChanged() // the sidebar reloads, and this page refreshes
    } catch (err) {
      toast({ title: "Couldn't unarchive the list", description: messageOf(err), tone: 'danger' })
    } finally {
      setUnarchiving(false)
    }
  }

  const columns: Column<RankedRow>[] = [
    {
      key: 'rank',
      header: '#',
      width: '64px',
      align: 'right',
      cell: (r) => <span className="tabular-nums text-muted">{formatCount(r.rank)}</span>,
    },
    {
      key: 'name',
      header: 'Name and property',
      cell: (r) => (
        <div className="min-w-0 max-w-[280px] py-1">
          <Link href={`/leads/${r.leadId}`} onClick={(e) => e.stopPropagation()} className="block truncate text-link hover:underline">
            {r.displayName}
          </Link>
          {r.address && <p className="truncate text-xs text-muted">{r.address}</p>}
        </div>
      ),
    },
    // Seam: "our value and range" goes here once Brief 44's estimates exist
    // (Ryan-only screens; never anything a buyer or homeowner sees [Ryan,
    // 2026-10-17]). No column until that data is present.
    { key: 'whyNow', header: 'Why now', cell: (r) => <WhyNowCell row={r} /> },
    { key: 'bestBuyer', header: 'Best buyer', width: '240px', cell: (r) => <BestBuyerCell buyer={r.bestBuyer} /> },
    { key: 'groups', header: 'Groups', width: '180px', cell: (r) => <GroupBadges groups={r.groups} /> },
    { key: 'attempts', header: 'Attempts', width: '96px', align: 'right', cell: (r) => <span className="tabular-nums">{r.attempts}</span> },
    {
      key: 'lastResult',
      header: 'Last result',
      width: '150px',
      cell: (r) => (
        <span className="flex flex-col">
          <span className={cn('truncate text-sm', !r.lastResult && 'text-subtle')}>{r.lastResult ?? '—'}</span>
          {/* Shown only while calling is on (always false otherwise) [brief §5.1 rule 3]. */}
          {r.calledToday && <span className="text-xs text-accent">called today</span>}
        </span>
      ),
    },
    {
      key: 'localTime',
      header: 'Local time',
      width: '160px',
      cell: (r) => <LocalTimeCell timezone={r.timezone} window={r.timezone ? data.callingWindows[r.timezone] : undefined} now={now} />,
    },
  ]

  const totalPages = Math.max(1, Math.ceil(data.total / data.pageSize))
  const from = data.rows.length === 0 ? 0 : (data.page - 1) * data.pageSize + 1
  const to = data.rows.length === 0 ? 0 : from + data.rows.length - 1
  const filtered = Boolean(filters.q || filters.group || filters.strongBuyer || filters.calledToday || filters.borough)

  return (
    <div className="flex h-full flex-col">
      <header className="flex shrink-0 flex-wrap items-start gap-3 border-b border-line px-4 py-3">
        {/* At phone width the buttons wrap under the title instead of squeezing it. */}
        <div className="min-w-[16rem] flex-1">
          <p className="truncate text-xs text-subtle">{list.folderName ?? 'No folder'}</p>
          <div className="flex min-w-0 items-center gap-2">
            {/* AppShell's top bar owns the page <h1>; this contributes a heading. */}
            <h2 className="min-w-0 truncate text-xl font-bold text-fg">{list.name}</h2>
            {archived && <Badge>Archived</Badge>}
          </div>
          <p className="mt-0.5 text-sm text-muted">
            {sourceLine(list)} ·{' '}
            <span suppressHydrationWarning>{rankedHeadline(data.rankedAt, now ?? new Date())}</span>
          </p>
        </div>
        <div className="flex shrink-0 flex-wrap items-start gap-2">
          <Button asChild>
            <a href={listExportUrl(list.id, filters)} download>
              <Download size={13} />
              Export CSV
            </a>
          </Button>
          <StartCalling callingOffReason={data.callingOffReason} />
        </div>
      </header>

      {archived && (
        <div role="status" className="flex shrink-0 flex-wrap items-center gap-2 border-b border-line bg-warning-subtle px-4 py-2 text-sm text-warning">
          <Archive size={14} className="shrink-0" />
          <span className="min-w-0 flex-1">
            This list is archived. It’s kept under Archived in the sidebar, and everyone on it is still in the CRM.
          </span>
          <Button size="sm" onClick={() => void unarchive()} loading={unarchiving}>
            Unarchive
          </Button>
        </div>
      )}

      <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-line px-4 py-2">
        <div className="w-full sm:w-56">
          <Input
            value={term}
            onChange={(e) => setTerm(e.target.value)}
            placeholder="Search this list…"
            leading={<Search size={13} />}
            aria-label="Search this list"
          />
        </div>
        <div className="w-44">
          <Select
            value={filters.group && !unknownGroup ? filters.group : 'any'}
            onValueChange={(v) => push({ group: v === 'any' ? undefined : v })}
            options={[
              { value: 'any', label: 'Group: Any' },
              { value: 'none', label: 'Group: None' },
              ...groups.map((g) => ({ value: g.id, label: `Group: ${g.name}` })),
            ]}
          />
        </div>
        <FilterToggle
          label="Has a strong buyer"
          pressed={Boolean(filters.strongBuyer)}
          onToggle={() => push({ strongBuyer: filters.strongBuyer ? undefined : true })}
          help="A buyer fits at 80 or more (DealFlow’s hot tier)."
        />
        <FilterToggle
          label="Called today"
          pressed={Boolean(filters.calledToday)}
          onToggle={() => push({ calledToday: filters.calledToday ? undefined : true })}
          disabledReason={data.callingOffReason}
        />
        <div className="w-44">
          <Select
            value={filters.borough ?? 'any'}
            onValueChange={(v) => push({ borough: v === 'any' ? undefined : v })}
            options={[{ value: 'any', label: 'Borough: Any' }, ...BOROUGHS.map((b) => ({ value: b, label: `Borough: ${b}` }))]}
          />
        </div>
        {filtered && (
          <Button variant="ghost" size="sm" onClick={clearFilters}>
            Clear filters
          </Button>
        )}

        <div className="ml-auto flex items-center gap-2">
          {selected.size > 0 && (
            <>
              <span className="text-sm text-muted">{formatCount(selected.size)} selected</span>
              {/* PR C puts <BulkActionsMenu leadIds listId onExport={exportSelected} /> here: Add to group,
                  Remove from group, Add to list, Remove from this list, Export CSV. */}
              <DropdownRoot>
                <DropdownTrigger asChild>
                  <Button size="sm">Bulk actions</Button>
                </DropdownTrigger>
                <DropdownContent>
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
            {pending ? 'Loading…' : `${formatCount(from)}–${formatCount(to)} of ${formatCount(data.total)}`}
            {!pending && filtered && data.total !== data.memberCount && ` (${formatCount(data.memberCount)} on the list)`}
          </span>
        </div>
      </div>

      {unknownGroup && (
        <div className="flex shrink-0 items-center gap-2 border-b border-line bg-warning-subtle px-4 py-2 text-sm text-warning">
          <AlertTriangle size={14} />
          That group no longer exists, so nobody matches it.
        </div>
      )}

      {/* Close runs the grid edge to edge — no card inset. */}
      <div className="min-h-0 flex-1 overflow-auto">
        <DataTable
          columns={columns}
          rows={data.rows}
          getRowId={(r) => r.leadId}
          // Every row carries its rank: each person's place in the whole list.
          rowAttributes={(r) => ({ 'data-rank': r.rank })}
          selectedIds={selected}
          onSelectedChange={setSelected}
          onRowActivate={(r) => router.push(`/leads/${r.leadId}`)}
          empty={
            data.memberCount === 0 ? (
              <EmptyState
                icon={<ListX />}
                title="No one is on this list yet."
                description="People you add to this list show here, always in ranked order."
              />
            ) : data.total > 0 ? (
              <EmptyState
                title="This page is past the end of the list."
                action={<Button onClick={() => push({}, 1)}>Go to the first page</Button>}
              />
            ) : (
              <EmptyState
                title="No one on this list matches these filters."
                description="Everyone is still on the list; the filters only narrow what you see."
                action={<Button onClick={clearFilters}>Clear filters</Button>}
              />
            )
          }
        />
      </div>

      {totalPages > 1 && (
        <div className="flex shrink-0 items-center justify-end gap-2 border-t border-line px-4 py-2">
          <Button size="sm" disabled={data.page <= 1} onClick={() => push({}, data.page - 1)}>
            <ChevronLeft size={13} />
            Previous
          </Button>
          <span className="text-sm text-muted">
            Page {data.page} of {totalPages}
          </span>
          <Button size="sm" disabled={data.page >= totalPages} onClick={() => push({}, data.page + 1)}>
            Next
            <ChevronRight size={13} />
          </Button>
        </div>
      )}
    </div>
  )
}

/** A list id that doesn't exist (deleted, or a mistyped link). */
export function ListNotFound() {
  return (
    <EmptyState
      icon={<ListX />}
      title="This list doesn’t exist"
      description="It may have been deleted. Deleting a list never deletes anyone: everyone who was on it is still in All leads."
      action={
        <Button variant="primary" asChild>
          <Link href="/leads">Open All leads</Link>
        </Button>
      }
    />
  )
}
