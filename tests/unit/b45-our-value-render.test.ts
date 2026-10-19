import { describe, it, expect } from 'vitest'
import { createElement as h } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import {
  AppRouterContext,
  type AppRouterInstance,
} from 'next/dist/shared/lib/app-router-context.shared-runtime'
import { ToastProvider, TooltipProvider } from '@/components/ui'
import type { PipelineFilterOptions, PipelineFilters, RankedPage, RankedRow } from '@/lib/core-data/lists/types'
import { ListView } from '@/app/lists/[id]/ListView'
import { rowsToCsv, LIST_CSV_COLUMNS } from '@/app/lists/[id]/csv'
import { PipelineView } from '@/app/pipeline/PipelineView'
import { FiltersPanel } from '@/app/pipeline/FiltersPanel'
import { FilterHelpTable } from '@/app/pipeline/FilterHelp'
import { FILTER_HELP } from '@/app/pipeline/filters'
import { parsePipelineUrl, pipelineSearch, panelFilterCount } from '@/app/pipeline/url'
import { parsePipelineQuery } from '@/lib/core-data/lists/pipeline'
import { HOT, NURTURE, OWNER1_HOT, OWNER2_HOT, card, makeBoard, makeTable, pageData } from './helpers/pipeline-fixtures'

// Brief 45 PR G — "our value and range" (Brief 44's estimate) on Ryan's own
// screens: the list page's column, the Pipeline card's value line and table
// column, and the Pipeline's value-range filter. Rendered on the server like
// the first paint. Made-up names and made-up values only. Values never go into
// a CSV export [Ryan, 2026-10-17: our value estimates never reach anything a
// buyer or homeowner sees; engineering precaution: exports can be forwarded].

const router: AppRouterInstance = { back() {}, forward() {}, refresh() {}, push() {}, replace() {}, prefetch() {} }
const wrap = (el: ReturnType<typeof h>) =>
  renderToStaticMarkup(h(AppRouterContext.Provider, { value: router }, h(TooltipProvider, null, h(ToastProvider, null, el))))
const decode = (s: string) =>
  s.replace(/&#x27;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&nbsp;/g, ' ')
const text = (html: string) => decode(html.replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ')
const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
function element(html: string, attr: string, value: string): string {
  const open = new RegExp(`<([a-z]+)[^>]*\\s${attr}="${esc(value)}"[^>]*>`).exec(html)
  expect(open, `an element with ${attr}="${value}"`).not.toBeNull()
  const tag = open![1]
  let depth = 0
  const re = new RegExp(`<${tag}[\\s>]|</${tag}>`, 'g')
  re.lastIndex = open!.index
  for (let m = re.exec(html); m; m = re.exec(html)) {
    depth += m[0].startsWith('</') ? -1 : 1
    if (depth === 0) return html.slice(open!.index, m.index + m[0].length)
  }
  throw new Error('unclosed element')
}
const headersOf = (html: string) => [...html.matchAll(/<th[^>]*>([\s\S]*?)<\/th>/g)].map((m) => text(m[1]).trim()).filter(Boolean)

const VALUE = { value: 1_830_000, low: 1_540_000, high: 2_120_000 }
const LABEL = 'DealFlow estimate · only you see this'

// ─── The list page ───────────────────────────────────────────────────────────

function row(rank: number, patch: Partial<RankedRow> = {}): RankedRow {
  return {
    rank, leadId: `lead_${rank}`, displayName: `Test Owner ${rank}`, address: `${100 + rank} Example St`,
    priorityScore: 80, topMatchFit: 85, rankState: 'ranked', notRankedReason: null, whyNow: 'Right neighborhood',
    bestBuyer: null, groups: [], attempts: 1, lastResult: null, timezone: null, calledToday: false,
    addedAt: '2026-10-18T14:00:00.000Z', value: null, ...patch,
  }
}

function listPage(rows: RankedRow[], patch: Partial<RankedPage> = {}): RankedPage {
  return {
    list: {
      id: 'l1', name: 'Brownstones likely to sell', folderId: null, folderName: null, source: 'manual', sortOrder: 0,
      archivedAt: null, memberCount: rows.length, createdAt: '2026-10-18T14:00:00.000Z',
    },
    total: rows.length, memberCount: rows.length, page: 1, pageSize: 100, rankedAt: '2026-10-18T11:02:00.000Z',
    callingOffReason: 'Calling is off', callingWindows: {}, hasValues: true, rows, ...patch,
  }
}

const renderList = (data: RankedPage) =>
  wrap(h(ListView, { data, groups: [], filters: {}, now: '2026-10-18T16:00:00.000Z' }))

describe('list page: the "Our value" column [brief §5.4]', () => {
  it('shows "$1.83M" with "likely $1.54M–$2.12M" under it, after name and property, and says whose estimate it is', () => {
    const html = renderList(listPage([row(1, { value: VALUE }), row(2)]))
    expect(headersOf(html)).toEqual(['#', 'Name and property', 'Our value', 'Why now', 'Best buyer', 'Groups', 'Attempts', 'Last result', 'Local time'])
    const t = text(html)
    expect(t).toContain('$1.83M')
    expect(t).toContain('likely $1.54M–$2.12M')
    expect(t).toContain(LABEL)
    // A row without an estimate says so with a dash, never a made-up number.
    const second = /<tr[^>]*data-rank="2"[^>]*>([\s\S]*?)<\/tr>/.exec(html)![1]
    expect(text(second)).not.toMatch(/\$/)
  })

  it('no column when nobody on the page has a value; before any estimate arrives the header says when they will', () => {
    const none = renderList(listPage([row(1), row(2)], { hasValues: false }))
    expect(headersOf(none)).not.toContain('Our value')
    expect(text(none)).toContain("Values appear after DealFlow's morning update.")
    expect(text(none)).not.toMatch(/\$/)
    // Estimates exist, just not for anyone on this page.
    const elsewhere = renderList(listPage([row(1), row(2)], { hasValues: true }))
    expect(headersOf(elsewhere)).not.toContain('Our value')
    expect(text(elsewhere)).not.toContain("Values appear after DealFlow's morning update.")
    expect(text(elsewhere)).toContain('No DealFlow estimates for anyone on this page.')
  })

  it('an empty list page says nothing about values (its empty state speaks)', () => {
    const empty = renderList(listPage([], { hasValues: false, memberCount: 0, total: 0 }))
    expect(text(empty)).not.toMatch(/Values appear|DealFlow estimate/)
  })

  it("the selected rows' CSV has the same columns as before and no value [engineering precaution]", () => {
    const csv = rowsToCsv([row(1, { value: VALUE })])
    expect(csv.split('\n')[0]).toBe(LIST_CSV_COLUMNS.join(','))
    expect(csv).not.toMatch(/1830000|1540000|2120000|1\.83M|likely|\$/)
  })
})

// ─── The Pipeline ────────────────────────────────────────────────────────────

const renderPipeline = (over: Parameters<typeof pageData>[0] = {}) => wrap(h(PipelineView, pageData(over)))

describe('Pipeline card: the value line [brief §5.6]', () => {
  it('a card with an estimate shows "$1.83M · likely $1.54M–$2.12M", labelled as ours; a card without one shows no value line', () => {
    const board = makeBoard()
    board.columns[0].cards[0] = { ...OWNER1_HOT, value: VALUE }
    const html = renderPipeline({ result: board })
    const c = element(element(html, 'data-column', HOT.id), 'data-card', OWNER1_HOT.leadId)
    expect(text(c)).toMatch(/\$1\.83M\s*·\s*likely \$1\.54M–\$2\.12M/)
    expect(decode(c)).toContain(LABEL)
    const plain = element(element(html, 'data-column', HOT.id), 'data-card', OWNER2_HOT.leadId)
    expect(text(plain)).not.toMatch(/\$|likely/)
  })
})

describe('Pipeline table: the "Our value" column', () => {
  it('shown when someone on the page has a value, right after the name', () => {
    const table = makeTable()
    table.rows[0] = { ...table.rows[0], value: VALUE }
    const html = element(renderPipeline({ query: { view: 'table', filters: {} }, result: table }), 'data-testid', 'pipeline-table')
    expect(headersOf(html)).toEqual(['#', 'Name', 'Our value', 'Groups', 'Best buyer', 'Last contact', 'Next task', 'Time in group'])
    expect(text(html)).toContain('$1.83M')
    expect(text(html)).toContain('likely $1.54M–$2.12M')
  })

  it('no column when nobody on the page has one', () => {
    const html = element(renderPipeline({ query: { view: 'table', filters: {} }, result: makeTable() }), 'data-testid', 'pipeline-table')
    expect(headersOf(html)).not.toContain('Our value')
  })
})

const OPTIONS = (hasValues: boolean): PipelineFilterOptions => ({ ...makeBoard().filterOptions, hasValues })
const panel = (filters: PipelineFilters, hasValues: boolean) =>
  wrap(h(FiltersPanel, {
    query: { view: 'board', filters }, lists: pageData().lists, folders: pageData().folders, archivedLists: [],
    filterOptions: OPTIONS(hasValues), onChange: () => {}, onClear: () => {}, onHelp: () => {},
  }))

describe('the value-range filter [brief §5.6]', () => {
  it('offered once the CRM has DealFlow estimates: lowest and highest value, in dollars', () => {
    const html = panel({}, true)
    const t = text(html)
    expect(t).toContain('Value range')
    expect(html).toMatch(/<input[^>]*aria-label="Lowest value"/)
    expect(html).toMatch(/<input[^>]*aria-label="Highest value"/)
    expect(t).not.toContain("appear after DealFlow's morning update")
  })

  it("not offered before any estimate arrives: the panel says when it will be", () => {
    const html = panel({}, false)
    expect(html).not.toMatch(/aria-label="Lowest value"/)
    expect(text(html)).toMatch(/Value range.*appear after DealFlow's morning update/)
  })

  it('a range already set (a saved workflow, a link) can still be changed, even before estimates arrive', () => {
    const html = panel({ valueMin: '1500000' }, false)
    expect(html).toMatch(/<input[^>]*aria-label="Lowest value"[^>]*value="1,500,000"|<input[^>]*value="1,500,000"[^>]*aria-label="Lowest value"/)
  })

  it('one chip for the range, removable; it counts as one filter on the Filters button', () => {
    const html = renderPipeline({ query: { view: 'board', filters: { valueMin: '1500000', valueMax: '2500000', borough: 'Brooklyn' } } })
    const chips = text(element(html, 'data-testid', 'filter-chips'))
    expect(chips).toContain('Value: $1.5M–$2.5M')
    expect(element(html, 'data-testid', 'filter-chips')).toContain('aria-label="Remove filter: Value: $1.5M–$2.5M"')
    expect(text(element(html, 'data-testid', 'filters-button'))).toMatch(/Filters\s*2/)
    expect(panelFilterCount({ valueMin: '1500000', valueMax: '2500000' })).toBe(1)
    expect(panelFilterCount({ valueMax: '900000' })).toBe(1)
    const atLeast = text(element(renderPipeline({ query: { view: 'board', filters: { valueMin: '1500000' } } }), 'data-testid', 'filter-chips'))
    expect(atLeast).toContain('Value: at least $1.5M')
    const atMost = text(element(renderPipeline({ query: { view: 'board', filters: { valueMax: '900000' } } }), 'data-testid', 'filter-chips'))
    expect(atMost).toContain('Value: at most $900K')
  })

  it('"How these filters work" says it uses DealFlow\'s estimate and leaves out homes without one', () => {
    const t = text(wrap(h(FilterHelpTable)))
    expect(t).toMatch(/Value range/)
    expect(t).toMatch(/DealFlow's estimate/)
    expect(t).toMatch(/without an estimate are left out/)
    expect(t).not.toContain('not offered yet')
    expect(FILTER_HELP.flatMap((r) => r.keys)).toEqual(expect.arrayContaining(['valueMin', 'valueMax']))
  })
})

describe('the value range in the Pipeline URL and API', () => {
  const parse = (search: string) => parsePipelineUrl(new URLSearchParams(search))

  it('page URL ⇄ query ⇄ API: valueMin and valueMax in whole dollars', () => {
    const query = { view: 'board' as const, filters: { valueMin: '1500000', valueMax: '2500000' } }
    const search = pipelineSearch({ query, workflowId: null })
    expect(search).toBe('?valueMin=1500000&valueMax=2500000')
    expect(parse(search.slice(1))).toMatchObject({ query, ignored: [] })
    expect(parsePipelineQuery(new URLSearchParams(search.slice(1))).filters).toEqual(query.filters)
    // Leading zeros are read as the same amount.
    expect(parse('valueMin=0900000').query.filters).toEqual({ valueMin: '900000' })
    expect(parsePipelineQuery(new URLSearchParams('valueMax=0900000')).filters).toEqual({ valueMax: '900000' })
  })

  it('the page reads a bad or backwards range leniently: left out, with a plain note', () => {
    const bad = parse('valueMin=lots&valueMax=-5&borough=Queens')
    expect(bad.query.filters).toEqual({ borough: 'Queens' })
    expect(bad.ignored).toEqual([
      "This link had a lowest value the Pipeline doesn't know (lots), so it was ignored.",
      "This link had a highest value the Pipeline doesn't know (-5), so it was ignored.",
    ])
    const backwards = parse('valueMin=3000000&valueMax=2000000')
    expect(backwards.query.filters).toEqual({})
    expect(backwards.ignored).toEqual(["This link's value range was backwards ($3M to $2M), so it was ignored."])
    expect(parse('value=900000').ignored).toEqual(["This link had a value filter the Pipeline doesn't know (900000), so it was ignored."])
  })

  it('the API refuses a bad or backwards range with a plain 400 (never guesses)', () => {
    const status = (qs: string) => {
      try {
        parsePipelineQuery(new URLSearchParams(qs))
        return 200
      } catch (e) {
        return (e as { status: number }).status
      }
    }
    for (const bad of ['valueMin=lots', 'valueMin=-5', 'valueMin=1.5', 'valueMax=1000000001', 'valueMin=12345678901', 'valueMin=3000000&valueMax=2000000', 'value=900000']) {
      expect([bad, status(bad)]).toEqual([bad, 400])
    }
    expect(status('valueMin=0&valueMax=1000000000')).toBe(200)
    expect(status('valueMin=2000000&valueMax=2000000')).toBe(200) // one exact amount
  })
})

describe('fixtures', () => {
  it('the shared Pipeline fixtures carry no value unless a test gives one', () => {
    expect(card({ leadId: 'x' }).value).toBeNull()
    expect(NURTURE.name).toBe('Nurture')
  })
})
