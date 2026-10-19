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
import { useCallback, useEffect, useId, useRef, useState, useTransition, type ReactNode } from 'react'
import { AlertTriangle, Archive, Check, ChevronLeft, ChevronRight, Download, ListX, Phone, Search } from 'lucide-react'
import {
  Badge,
  Button,
  DataTable,
  EmptyState,
  Input,
  Select,
  Tooltip,
  useToast,
  type Column,
} from '@/components/ui'
import { cn } from '@/lib/ui/cn'
import { BOROUGHS, type BestBuyerDTO, type CallingWindowDTO, type GroupChipDTO, type MemberFilters, type RankedPage, type RankedRow } from '@/lib/core-data/lists/types'
import { LISTS_CHANGED_EVENT, getListMemberIds, listExportUrl, notifyListsChanged, updateList } from '@/lib/core-data/lists/client'
import { BulkActionsMenu } from '@/components/lists/BulkActionsMenu'
import { RowGroupChips } from '@/components/lists/RowGroupChips'
import { OUR_VALUE_LABEL, OurValueCell, ourValueParts, valuesNote } from '@/components/lists/OurValue'
import { chipClassName } from '@/components/lists/GroupChips'
import { SelectAllMatching } from '@/components/lists/SelectAllMatching'
import { selectAllOffer } from '@/components/lists/bulk-actions'
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

// ─── Fitting the page ─────────────────────────────────────────────────────────

// Brief 50 PR 7 (open item 6.12): the table fits its box instead of scrolling
// sideways (Brief 45 measured 228 px too wide at 1280 px, more with the value
// column, and most of the table on a phone). The box is a CSS size container;
// as it narrows, the less-used columns fold into a neighbouring cell instead
// of disappearing, so every fact stays on the row:
//   ≥ 1408 px  every column;
//   < 1408 px  local time goes under the calls;
//   < 1248 px  the best buyer goes under "why now";
//   < 1024 px  our value and the calls (with local time) go under the name;
//   <  768 px  (phones) "why now" (with the best buyer) and the groups go under
//              the name too, read-only: the row is #, name and the facts beneath.
// The widths leave room for the longest name, value, group and badge a cell
// allows (names and buyers truncate, reasons and badges wrap), so each tier
// fits from its first width: in a 1,280 px window the box is about 1,028 px,
// at 1,440 px about 1,188 px, on a phone the whole width. Tailwind needs each
// class written out, so every tier is a literal pair: its column, and its
// facts folded.
export const FIT = {
  phone: { column: 'hidden @min-[48rem]:table-cell', folded: '@min-[48rem]:hidden' },
  narrow: { column: 'hidden @min-[64rem]:table-cell', folded: '@min-[64rem]:hidden' },
  medium: { column: 'hidden @min-[78rem]:table-cell', folded: '@min-[78rem]:hidden' },
  wide: { column: 'hidden @min-[88rem]:table-cell', folded: '@min-[88rem]:hidden' },
} as const

// ─── Cells ────────────────────────────────────────────────────────────────────

/** Why now, or why this person isn't ranked (they sit at the bottom). Folded under the name, nothing instead of a dash. */
function WhyNow({ row, folded = false }: { row: RankedRow; folded?: boolean }) {
  const badge = rankBadge(row)
  if (badge) {
    return (
      <Tooltip content={badge.help}>
        <span
          className={cn(
            // Brief 50 PR 7: may wrap in a narrow column rather than widen the table.
            'inline-block rounded-[0.625rem] px-2 py-0.5 text-xs leading-4',
            row.rankState === 'scoring' ? 'bg-accent-subtle text-accent' : 'bg-active text-muted',
          )}
        >
          {badge.label}
        </span>
      </Tooltip>
    )
  }
  if (row.whyNow) return <span className="line-clamp-2 text-sm">{row.whyNow}</span>
  return folded ? null : <span className="text-subtle">—</span>
}

/**
 * "Best buyer: Sample Buyer Agent 91 Test" for a folded cell: at most two
 * lines, then cut short with "…". It wraps, so it never sets the cell's width
 * the way an unbreakable line would.
 */
function BestBuyerLine({ buyer, className }: { buyer: BestBuyerDTO; className?: string }) {
  return (
    <span className={cn('line-clamp-2 text-xs', className)} title={buyer.name}>
      <span className="text-subtle">Best buyer:</span> {buyer.name}
      {buyer.score != null && <span className="tabular-nums text-muted"> {buyer.score}</span>}
      {buyer.isTestData && <Badge className="ml-1.5 align-middle">Test</Badge>}
    </span>
  )
}

function WhyNowCell({ row }: { row: RankedRow }) {
  return (
    <div className="flex min-w-[9rem] flex-col items-start gap-0.5 py-1">
      <WhyNow row={row} />
      {row.bestBuyer && <BestBuyerLine buyer={row.bestBuyer} className={FIT.medium.folded} />}
    </div>
  )
}

function BestBuyerCell({ buyer }: { buyer: BestBuyerDTO | null }) {
  if (!buyer) return <span className="text-subtle">—</span>
  return (
    <span className="flex w-[11rem] min-w-0 items-center gap-1.5 whitespace-nowrap text-sm">
      <span className="min-w-0 truncate" title={buyer.name}>
        {buyer.name}
      </span>
      {buyer.score != null && <span className="shrink-0 tabular-nums text-muted">{buyer.score}</span>}
      {buyer.isTestData && <Badge className="shrink-0">Test</Badge>}
    </span>
  )
}

/** "2 calls", "1 call", "No calls yet". */
export const callsText = (attempts: number) => (attempts > 0 ? `${formatCount(attempts)} ${attempts === 1 ? 'call' : 'calls'}` : 'No calls yet')

/** Calls made and the last result; "called today" only while calling is on [brief §5.1 rule 3]. */
function CallsCell({ row, localTime }: { row: RankedRow; localTime: ReactNode }) {
  return (
    <span className="flex w-[8rem] flex-col py-1">
      <span className="truncate text-sm" title={row.lastResult ?? undefined}>
        <span className="tabular-nums">{callsText(row.attempts)}</span>
        {row.lastResult && ` · ${row.lastResult}`}
      </span>
      {/* Shown only while calling is on (always false otherwise) [brief §5.1 rule 3]. */}
      {row.calledToday && <span className="text-xs text-accent">called today</span>}
      {row.timezone && <span className={cn('text-xs', FIT.wide.folded)}>{localTime}</span>}
    </span>
  )
}

/** The person, and beneath, the facts of the columns folded at this width. */
function NameCell({ row, localTime }: { row: RankedRow; localTime: ReactNode }) {
  return (
    // On a phone the cell takes the box's width less the checkbox and # columns (cqw: the box's width).
    <div className="flex min-w-0 max-w-[calc(100cqw-8.5rem)] flex-col gap-0.5 py-1 @min-[48rem]:max-w-[13rem]">
      <Link href={`/leads/${row.leadId}`} onClick={(e) => e.stopPropagation()} className="block truncate text-link hover:underline" title={row.displayName}>
        {row.displayName}
      </Link>
      {row.address && <p className="truncate text-xs text-muted">{row.address}</p>}
      {row.value && (
        <span className={cn('truncate text-xs tabular-nums', FIT.narrow.folded)} title={OUR_VALUE_LABEL}>
          {`${ourValueParts(row.value).value} · ${ourValueParts(row.value).range}`}
        </span>
      )}
      {(rankBadge(row) || row.whyNow || row.bestBuyer) && (
        <span className={cn('flex min-w-0 flex-col items-start gap-0.5', FIT.phone.folded)}>
          <WhyNow row={row} folded />
          {row.bestBuyer && <BestBuyerLine buyer={row.bestBuyer} />}
        </span>
      )}
      {row.groups.length > 0 && (
        <span className={cn('flex flex-wrap gap-1', FIT.phone.folded)}>
          {row.groups.map((g) => (
            <span key={g.id} className={chipClassName(g.color, true, true)}>
              <span className="min-w-0 max-w-[9rem] truncate">{g.name}</span>
            </span>
          ))}
        </span>
      )}
      <span className={cn('flex flex-col text-xs text-muted', FIT.narrow.folded)}>
        <span className="line-clamp-2">
          <span className="tabular-nums">{callsText(row.attempts)}</span>
          {row.lastResult && ` · ${row.lastResult}`}
          {row.calledToday && <span className="text-accent"> · called today</span>}
        </span>
        {row.timezone && localTime}
      </span>
    </div>
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
  // Brief 45 (PR C): each row's group chips keep their own state once shown
  // (RowGroupChips). After a bulk change they start again from the first rows
  // that arrive after it: their key carries this number.
  const [chipsVersion, setChipsVersion] = useState(0)
  const bulkChanged = useRef(false)
  useEffect(() => {
    const viewChanged = lastViewKey.current !== viewKey
    lastViewKey.current = viewKey
    setSelected((picked) => keepSelection(picked, data.rows, viewChanged))
    if (bulkChanged.current) {
      bulkChanged.current = false
      setChipsVersion((v) => v + 1)
    }
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

  // Brief 45 (PR C): the bulk menu's Export CSV, with the same rules as All
  // leads. Everyone matching selected ("Select all N matching"): the list's
  // ranked CSV with these filters. Some selected on other pages: nothing, and
  // it says so (this page's rows are all the browser has). Otherwise: the
  // selected rows of this page.
  const pageIds = data.rows.map((r) => r.leadId)
  const everyoneSelected = selectAllOffer({ pageIds, selected, total: data.total }).kind === 'all'
  const exportForMenu = useCallback(() => {
    if (!everyoneSelected) {
      const elsewhere = selected.size - data.rows.filter((r) => selected.has(r.leadId)).length
      if (elsewhere > 0) {
        toast({
          tone: 'danger',
          title: 'Nothing exported',
          description: `${formatCount(elsewhere)} of the ${formatCount(selected.size)} selected ${elsewhere === 1 ? 'is on another page' : 'are on other pages'}. Select all matching to export everyone, or export one page at a time.`,
        })
        return
      }
      return exportSelected()
    }
    const a = document.createElement('a')
    a.href = listExportUrl(list.id, filters)
    a.click()
    toast({ title: `Exporting all ${formatCount(selected.size)} matching people` })
  }, [everyoneSelected, exportSelected, data.rows, list.id, filters, selected, toast])

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

  const showValues = data.rows.some((r) => r.value)
  const valueNote = valuesNote(data)

  const localTime = (r: RankedRow) => (
    <LocalTimeCell timezone={r.timezone} window={r.timezone ? data.callingWindows[r.timezone] : undefined} now={now} />
  )
  // Brief 50 PR 7: each column's FIT tier says from what width it shows; below
  // it, its facts are folded into a neighbouring cell (see FIT).
  const columns: Column<RankedRow>[] = [
    {
      key: 'rank',
      header: '#',
      width: '56px',
      align: 'right',
      cell: (r) => <span className="tabular-nums text-muted">{formatCount(r.rank)}</span>,
    },
    { key: 'name', header: 'Name and property', cell: (r) => <NameCell row={r} localTime={localTime(r)} /> },
    // Brief 45 PR G: our value and range (Brief 44's estimate, the lead
    // page's), shown only when someone on this page has one; the header says
    // why otherwise. Ryan's own screen: never in the CSV export [Ryan,
    // 2026-10-17: our value estimates never reach anything a buyer or
    // homeowner sees].
    ...(showValues
      ? [{ key: 'ourValue', header: 'Our value', width: '140px', className: FIT.narrow.column, cell: (r: RankedRow) => <OurValueCell value={r.value} /> }]
      : []),
    { key: 'whyNow', header: 'Why now', className: FIT.phone.column, cell: (r) => <WhyNowCell row={r} /> },
    { key: 'bestBuyer', header: 'Best buyer', width: '200px', className: FIT.medium.column, cell: (r) => <BestBuyerCell buyer={r.bestBuyer} /> },
    {
      key: 'groups',
      header: 'Groups',
      width: '200px',
      className: FIT.phone.column,
      // Brief 45 (PR C): one click on, one click off; keys 1–9 while the row has focus.
      cell: (r) => <RowGroupChips key={`${r.leadId}:${chipsVersion}`} leadId={r.leadId} groups={r.groups} />,
    },
    // Brief 50 PR 7: attempts and the last result in one column.
    { key: 'calls', header: 'Calls', width: '152px', className: FIT.narrow.column, cell: (r) => <CallsCell row={r} localTime={localTime(r)} /> },
    { key: 'localTime', header: 'Local time', width: '150px', className: FIT.wide.column, cell: localTime },
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
          {valueNote && (
            <p data-testid="values-note" className="mt-0.5 text-xs text-subtle">
              {valueNote}
            </p>
          )}
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
              {/* Brief 45 (PR C): Add to group · Remove from group · Add to list ·
                  Remove from this list · Export CSV [brief §5.4]. Only "Remove
                  from this list" takes anyone off this list's call order
                  [Ryan, 2026-10-18]; nobody is ever deleted. */}
              <BulkActionsMenu
                leadIds={[...selected]}
                listId={list.id}
                onDone={() => {
                  bulkChanged.current = true
                  router.refresh()
                }}
                onExport={exportForMenu}
              />
            </>
          )}
          <span className="text-sm text-subtle" aria-live="polite">
            {pending ? 'Loading…' : `${formatCount(from)}–${formatCount(to)} of ${formatCount(data.total)}`}
            {!pending && filtered && data.total !== data.memberCount && ` (${formatCount(data.memberCount)} on the list)`}
          </span>
        </div>
      </div>

      {/* Brief 45 (PR C): everyone on the list who matches the filters, past
          this page. A load that finishes after the view changed is dropped. */}
      <SelectAllMatching
        pageIds={pageIds}
        selected={selected}
        total={data.total}
        scope={viewKey}
        onSelect={setSelected}
        loadAll={() => getListMemberIds(list.id, filters)}
      />

      {unknownGroup && (
        <div className="flex shrink-0 items-center gap-2 border-b border-line bg-warning-subtle px-4 py-2 text-sm text-warning">
          <AlertTriangle size={14} />
          That group no longer exists, so nobody matches it.
        </div>
      )}

      {/* Close runs the grid edge to edge — no card inset. Brief 50 PR 7: a size
          container, so the columns follow the room the table has (FIT). */}
      <div className="@container min-h-0 flex-1 overflow-auto">
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
