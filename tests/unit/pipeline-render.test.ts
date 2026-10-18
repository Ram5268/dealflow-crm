import { describe, it, expect } from 'vitest'
import { createElement as h } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import {
  AppRouterContext,
  type AppRouterInstance,
} from 'next/dist/shared/lib/app-router-context.shared-runtime'
import { ToastProvider, TooltipProvider } from '@/components/ui'
import { PipelineView } from '@/app/pipeline/PipelineView'
import { FiltersPanel } from '@/app/pipeline/FiltersPanel'
import { FilterHelpTable } from '@/app/pipeline/FilterHelp'
import { FILTER_HELP } from '@/app/pipeline/filters'
import type { PipelinePageData } from '@/app/pipeline/types'
import { SHORTCUT_GROUPS } from '@/components/shell/ShortcutsSheet'
import { PALETTE_ACTIONS } from '@/components/shell/CommandPalette'
import { ALL_DESTINATIONS, PRIMARY_NAV } from '@/lib/ui/nav'
import { GO_TO_ROUTES } from '@/lib/ui/hotkeys'
import { PIPELINE_FILTER_KEYS } from '@/lib/core-data/lists/types'
import { APPT, HOT, NURTURE, WORKFLOWS, makeBoard, makeTable, pageData } from './helpers/pipeline-fixtures'

// Brief 45 PR D — what the Pipeline page shows [brief §5.6], rendered on the
// server exactly as the first paint (renderToStaticMarkup). Made-up data.

const router: AppRouterInstance = { back() {}, forward() {}, refresh() {}, push() {}, replace() {}, prefetch() {} }
const wrap = (el: ReturnType<typeof h>) =>
  renderToStaticMarkup(h(AppRouterContext.Provider, { value: router }, h(TooltipProvider, null, h(ToastProvider, null, el))))
const render = (over: Partial<PipelinePageData> = {}) => wrap(h(PipelineView, pageData(over)))

const decode = (s: string) =>
  s.replace(/&#x27;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&nbsp;/g, ' ')
const text = (html: string) => decode(html.replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ')

const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/** The markup of the element carrying `attr="value"` (up to its matching close tag). */
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
const classesOf = (html: string, attr: string, value: string) =>
  new RegExp(`<[a-z]+[^>]*\\s${attr}="${esc(value)}"[^>]*>`).exec(html)![0].match(/class="([^"]*)"/)![1].split(/\s+/)

describe('the board', () => {
  const html = render()

  it('one column per group, in sidebar order, each header with its count', () => {
    const order = [...html.matchAll(/data-column="([^"]+)"/g)].map((m) => m[1])
    expect(order).toEqual([HOT.id, NURTURE.id, APPT.id])
    expect(text(element(html, 'data-column-header', HOT.id))).toMatch(/Hot\s*2/)
    expect(text(element(html, 'data-column-header', APPT.id))).toMatch(/Appointment Set\s*1/)
  })

  it('a card: name and property, best buyer, last contact, next task and due date, time in group, chips', () => {
    const hot = element(html, 'data-column', HOT.id)
    const c = element(hot, 'data-card', 'lead_1')
    expect(c).toContain('href="/leads/lead_1"')
    const t = text(c)
    for (const s of ['Test Owner 1', '101 Example St', 'Sample Buyer Agent', '92', 'Test', 'Last contact 3 days ago', 'Call back', 'due today', 'In Hot for 100 days', '#2']) {
      expect(t).toContain(s)
    }
    expect(text(element(c, 'data-testid', 'card-groups'))).toMatch(/Hot\s*Nurture/)
    // Our value estimate isn't shown until Brief 44's data exists.
    expect(t).not.toMatch(/\$|value/i)
  })

  it('an "also in" mark when the person is in two groups (both columns)', () => {
    expect(text(element(element(html, 'data-column', HOT.id), 'data-card', 'lead_1'))).toContain('Also in Nurture')
    expect(text(element(element(html, 'data-column', NURTURE.id), 'data-card', 'lead_1'))).toContain('Also in Hot')
    expect(element(element(html, 'data-column', HOT.id), 'data-card', 'lead_2')).not.toContain('Also in')
  })

  it('never contacted, overdue and "no task" read plainly', () => {
    expect(text(element(html, 'data-card', 'lead_3'))).toContain('Never contacted')
    expect(text(element(element(html, 'data-column', HOT.id), 'data-card', 'lead_2'))).toMatch(/Overdue follow-up.*overdue since Oct 10/)
    expect(text(element(html, 'data-card', 'lead_4'))).not.toMatch(/due|task/i)
  })

  it('cards are draggable, and say how to move them by keyboard', () => {
    const c = element(element(html, 'data-column', HOT.id), 'data-card', 'lead_1')
    expect(c).toMatch(/draggable="true"/)
    const describedBy = /aria-describedby="([^"]+)"/.exec(c)![1]
    expect(text(element(html, 'id', describedBy))).toMatch(/\[ and \] move .* M .*Enter/)
  })

  it('"load more" on a column with more cards than shown', () => {
    const board = makeBoard()
    board.columns[1] = { ...board.columns[1], count: 75, hasMore: true }
    expect(text(element(render({ result: board }), 'data-column', NURTURE.id))).toContain('Load more (73 left)')
    expect(html).not.toContain('Load more')
  })

  it('an empty column says why', () => {
    const board = makeBoard()
    board.columns[2] = { ...board.columns[2], count: 0, cards: [] }
    expect(text(element(render({ result: board }), 'data-column', APPT.id))).toContain('No one in Appointment Set yet.')
    expect(text(element(render({ result: board, query: { view: 'board', filters: { tier: 'hot' } } }), 'data-column', APPT.id))).toContain(
      'No one here matches these filters.',
    )
  })

  it('phone width: the columns become a swipeable row (scroll-snap); desktop keeps fixed columns', () => {
    const board = classesOf(html, 'data-testid', 'pipeline-board')
    expect(board).toEqual(expect.arrayContaining(['overflow-x-auto', 'snap-x', 'snap-mandatory', 'sm:snap-none']))
    const col = classesOf(html, 'data-column', HOT.id)
    expect(col).toEqual(expect.arrayContaining(['w-[85vw]', 'snap-start', 'sm:w-72', 'shrink-0']))
  })
})

describe('the empty Pipeline', () => {
  it('no groups yet: "Create a group to start your pipeline" with a + Group button, and nothing else', () => {
    const html = render({ groups: [], result: null, workflows: [] })
    expect(text(html)).toContain('Create a group to start your pipeline')
    expect(html).toMatch(/<button[^>]*>\s*\+ Group\s*<\/button>/)
    expect(html).not.toContain('data-testid="pipeline-board"')
    expect(html).not.toContain('Filters')
  })
})

describe('the table', () => {
  const html = render({ query: { view: 'table', filters: {} }, result: makeTable() })

  it('one row per person (two groups = one row, both chips), sortable columns, rank first', () => {
    const table = element(html, 'data-testid', 'pipeline-table')
    expect([...table.matchAll(/data-row="([^"]+)"/g)].map((m) => m[1])).toEqual(['lead_1', 'lead_2', 'lead_4', 'lead_3'])
    const headers = [...table.matchAll(/<th[^>]*>([\s\S]*?)<\/th>/g)].map((m) => text(m[1]).trim()).filter(Boolean)
    expect(headers).toEqual(['#', 'Name', 'Groups', 'Best buyer', 'Last contact', 'Next task', 'Time in group'])
    // (The select-all checkbox in the first header is a button too; it isn't a sort.)
    const sortable = [...table.matchAll(/<th[^>]*>\s*<button(?![^>]*role="checkbox")[^>]*>([\s\S]*?)<\/button>/g)].map((m) => text(m[1]).trim())
    expect(sortable).toEqual(['#', 'Name', 'Last contact', 'Next task', 'Time in group'])
    expect(table).toMatch(/aria-sort="ascending"[^>]*>\s*<button[^>]*>#/)
    expect(text(element(table, 'data-row-groups', 'lead_1'))).toMatch(/Hot\s*Nurture/)
    expect(text(element(table, 'data-row-groups', 'lead_2')).trim()).toBe('Hot')
  })

  it('a sort from the URL is shown on its column', () => {
    const sorted = render({ query: { view: 'table', filters: {}, sort: 'lastContact', dir: 'desc' }, result: makeTable() })
    expect(element(sorted, 'data-testid', 'pipeline-table')).toMatch(/aria-sort="descending"[^>]*>\s*<button[^>]*>Last contact/)
  })

  it('100 rows a page', () => {
    const big = render({ query: { view: 'table', filters: {}, page: 1 }, result: makeTable({ total: 230 }) })
    expect(text(big)).toContain('1–100 of 230')
    expect(text(big)).toContain('Page 1 of 3')
  })

  it('rows can be selected for the bulk actions', () => {
    expect(element(html, 'data-testid', 'pipeline-table')).toContain('role="checkbox"')
  })
})

describe('filters [brief §5.6]', () => {
  it('active filters show as removable chips, the count is on the Filters button, and they can all be cleared', () => {
    const html = render({ query: { view: 'board', filters: { multiGroup: '1', borough: 'Brooklyn', list: 'l_oct', lastContact: 'over30' } } })
    const chips = text(element(html, 'data-testid', 'filter-chips'))
    for (const s of ['In more than one group', 'Borough: Brooklyn', 'List: Expireds – Oct 2026', 'Last contact: over 30 days ago', 'Clear all']) {
      expect(chips).toContain(s)
    }
    expect(text(element(html, 'data-testid', 'filters-button'))).toMatch(/Filters\s*4/)
    expect(element(html, 'data-testid', 'filter-chips')).toMatch(/aria-label="Remove filter: In more than one group"/)
  })

  it('a folder filter and an archived list are named; a deleted one says so', () => {
    const folder = render({ query: { view: 'board', filters: { folder: 'f_exp' } } })
    expect(text(element(folder, 'data-testid', 'filter-chips'))).toContain('Folder: Expireds')
    const gone = render({ query: { view: 'board', filters: { list: 'l_gone' } } })
    expect(text(element(gone, 'data-testid', 'filter-chips'))).toContain('List: (deleted list)')
  })

  it('the panel offers every filter but value range (not until Brief 44), and nothing about personal circumstances', () => {
    const panel = wrap(h(FiltersPanel, {
      query: { view: 'board', filters: {} }, lists: pageData().lists, folders: pageData().folders, archivedLists: [],
      filterOptions: makeBoard().filterOptions, onChange: () => {}, onClear: () => {}, onHelp: () => {},
    }))
    const t = text(panel)
    for (const label of ['List or folder', 'Borough', 'Neighborhood', 'Property type', 'Units', 'DealFlow tier', 'Has a strong buyer',
      'Last contact', 'Task due', 'Time in group', 'In more than one group', 'How these filters work']) {
      expect(t).toContain(label)
    }
    expect(t).toMatch(/Value range.*not available yet/i)
    expect(t).not.toMatch(/estate|probate|divorce|illness|\bage\b/i)
  })

  it('"How these filters work" names the field behind each filter', () => {
    const t = text(wrap(h(FilterHelpTable)))
    const covered = FILTER_HELP.flatMap((row) => row.keys)
    for (const key of PIPELINE_FILTER_KEYS) expect(covered).toContain(key)
    for (const s of ['Property Zip Code', 'Property City', 'Property Type', 'Last Contacted Date', 'never contacted', 'today through Sunday',
      'New York', 'active lists', '80', '65', 'not offered yet', 'Called today']) {
      expect(t).toContain(s)
    }
  })
})

describe('saved workflows as tabs [brief §5.6]', () => {
  it('tabs across the top: All groups, then each saved workflow, linked by id', () => {
    const html = render()
    const tabs = element(html, 'data-testid', 'workflow-tabs')
    expect(text(tabs)).toMatch(/All groups.*Brownstone nurtures.*Expired hot leads/)
    expect(tabs).toContain('href="/pipeline?wf=wf_brown"')
    expect(/<a[^>]*href="\/pipeline"[^>]*>/.exec(tabs)![0]).toContain('aria-current="page"')
    expect(/<a[^>]*href="\/pipeline\?wf=wf_brown"[^>]*>/.exec(tabs)![0]).not.toContain('aria-current')
  })

  it('an open workflow that still matches: no "unsaved" prompt', () => {
    const html = render({ workflowId: 'wf_brown', query: { view: 'board', groups: [NURTURE.id], filters: { borough: 'Brooklyn' } } })
    const tab = /<a[^>]*href="\/pipeline\?wf=wf_brown"[^>]*>/.exec(html)![0]
    expect(tab).toContain('aria-current="page"')
    expect(text(html)).not.toContain('Unsaved changes')
  })

  it('changed since it was saved: Update it, or save as a new tab', () => {
    const html = render({ workflowId: 'wf_brown', query: { view: 'board', groups: [NURTURE.id], filters: { borough: 'Queens' } } })
    expect(text(html)).toContain('Unsaved changes')
    expect(text(html)).toContain('Update “Brownstone nurtures”')
    expect(text(html)).toContain('Save as new')
  })

  it('filters on the All groups tab can be saved as a workflow', () => {
    expect(text(render({ query: { view: 'board', filters: { tier: 'hot' } } }))).toContain('Save as workflow')
    expect(text(render())).not.toContain('Save as workflow')
  })

  it('a workflow whose group was deleted still opens, with a plain note', () => {
    const note = 'The group this workflow showed was deleted, so it shows every group now.'
    const html = render({ workflowId: 'wf_brown', query: { view: 'board', filters: { borough: 'Brooklyn' } }, notices: [note] })
    expect(text(html)).toContain(note)
    expect(html).toContain('data-testid="pipeline-board"')
  })

  it('with no workflows yet there is still the All groups tab', () => {
    expect(text(element(render({ workflows: [] }), 'data-testid', 'workflow-tabs'))).toContain('All groups')
  })
})

describe('getting there and the keys', () => {
  it('Pipeline is in the main nav (g p) and ⌘K has "Open Pipeline"', () => {
    expect(PRIMARY_NAV.find((n) => n.href === '/pipeline')).toMatchObject({ label: 'Pipeline', goKey: 'p' })
    expect(ALL_DESTINATIONS.some((n) => n.href === '/pipeline')).toBe(true)
    expect(GO_TO_ROUTES.p).toBe('/pipeline')
    expect(PALETTE_ACTIONS.find((a) => a.label === 'Open Pipeline')).toMatchObject({ href: '/pipeline' })
  })

  it('the shortcuts sheet lists every Pipeline key', () => {
    const pipeline = SHORTCUT_GROUPS.find((g) => g.title === 'Pipeline')!
    const keys = pipeline.items.map((i) => i.keys.join(' '))
    expect(keys).toEqual(expect.arrayContaining(['↑ ↓ ← →', '[', ']', 'M', 'Enter']))
    expect(SHORTCUT_GROUPS.find((g) => g.title === 'Go to')!.items).toContainEqual({ keys: ['g', 'p'], label: 'Pipeline' })
  })

  it('nothing on the page contacts anyone: no call, text or email controls', () => {
    const t = text(render()) + text(render({ query: { view: 'table', filters: {} }, result: makeTable() }))
    expect(t).not.toMatch(/\b(Call now|Dial|Send|Text|Email|Enroll)\b/)
  })
})

describe('notices', () => {
  it('shows what the server ignored in the link', () => {
    const html = render({ notices: ["Filtering by value isn't available yet: our estimates aren't in the CRM."] })
    expect(text(element(html, 'data-testid', 'pipeline-notices'))).toContain("Filtering by value isn't available yet")
  })

  it('workflows fixture sanity', () => {
    expect(WORKFLOWS.map((w) => w.name)).toEqual(['Brownstone nurtures', 'Expired hot leads'])
  })
})
