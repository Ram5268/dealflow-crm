import { describe, it, expect } from 'vitest'
import {
  DEFAULT_QUERY, normalizeQuery, parsePipelineUrl, pipelineHref, pipelineSearch, sameQuery, withFilter,
} from '@/app/pipeline/url'
import { parsePipelineQuery } from '@/lib/core-data/lists/pipeline'
import { PIPELINE_FILTER_KEYS, type PipelineFilters, type PipelineQuery } from '@/lib/core-data/lists/types'

// Brief 45 PR D — every Pipeline filter lives in the page's URL [brief §5.6].
// The page writes the URL (pipelineSearch), reads it back (parsePipelineUrl),
// and the same string is what PR A's API parser (parsePipelineQuery) accepts,
// so the page, a bookmark and the API always agree.

const ONE_OF_EACH: [keyof PipelineFilters, string][] = [
  ['list', 'l_oct'],
  ['folder', 'f_exp'],
  ['borough', 'Staten Island'],
  ['neighborhood', 'Bedford-Stuyvesant'],
  ['propertyType', 'Apartment House (5+ Units)'],
  ['units', '5+'],
  ['tier', 'possible'],
  ['strongBuyer', '1'],
  ['valueMin', '1500000'],
  ['valueMax', '2500000'],
  ['lastContact', 'over90'],
  ['taskDue', 'overdue'],
  ['timeInGroup', '60'],
  ['multiGroup', '1'],
  ['q', 'Example St & 5th'],
]

const parse = (search: string) => parsePipelineUrl(new URLSearchParams(search.replace(/^\?/, '')))

describe('the Pipeline URL', () => {
  it('covers every filter the API has (and no others)', () => {
    expect(ONE_OF_EACH.map(([k]) => k).sort()).toEqual([...PIPELINE_FILTER_KEYS].sort())
  })

  it.each(ONE_OF_EACH)('filter %s: page URL ⇄ query, and the API parses the same string the same way', (key, value) => {
    const query: PipelineQuery = { view: 'board', filters: { [key]: value } }
    const search = pipelineSearch({ query, workflowId: null })
    expect(search.startsWith('?')).toBe(true)
    const back = parse(search)
    expect(back.query).toEqual(query)
    expect(back.ignored).toEqual([])
    expect(parsePipelineQuery(new URLSearchParams(search.slice(1))).filters).toEqual({ [key]: value })
  })

  it('every filter at once, with the columns, the table, its sort and page, and the open workflow', () => {
    const query: PipelineQuery = {
      view: 'table', groups: ['g_hot', 'g_nurture'], filters: Object.fromEntries(ONE_OF_EACH) as PipelineFilters,
      sort: 'lastContact', dir: 'desc', page: 3,
    }
    const search = pipelineSearch({ query, workflowId: 'wf_brown' })
    expect(parse(search)).toEqual({ query, workflowId: 'wf_brown', explicit: true, ignored: [] })
    const api = parsePipelineQuery(new URLSearchParams(search.slice(1)))
    expect(api).toMatchObject({ view: 'table', groups: ['g_hot', 'g_nurture'], filters: query.filters, sort: 'lastContact', dir: 'desc', page: 3 })
  })

  it('"5+" and "(5+ Units)" survive the trip (a bare + would read back as a space)', () => {
    const search = pipelineSearch({ query: { view: 'board', filters: { units: '5+', propertyType: 'Apartment House (5+ Units)' } }, workflowId: null })
    expect(search).toContain('units=5%2B')
    expect(search).not.toMatch(/units=5\+/)
  })

  it('the default view is a bare /pipeline; defaults are left out of the URL', () => {
    expect(pipelineHref({ query: DEFAULT_QUERY, workflowId: null })).toBe('/pipeline')
    expect(pipelineHref({ query: { view: 'board', filters: {}, sort: 'rank', dir: 'asc', page: 1, groups: [] }, workflowId: null })).toBe('/pipeline')
    expect(pipelineHref({ query: { view: 'table', filters: {} }, workflowId: null })).toBe('/pipeline?view=table')
    expect(parse('')).toEqual({ query: DEFAULT_QUERY, workflowId: null, explicit: false, ignored: [] })
  })

  it('a workflow tab link is just its id; once anything changes, the URL says so (explicit)', () => {
    expect(pipelineHref({ query: DEFAULT_QUERY, workflowId: 'wf_brown' })).toBe('/pipeline?wf=wf_brown&view=board')
    expect(parse('?wf=wf_brown')).toMatchObject({ workflowId: 'wf_brown', explicit: false })
    // Clearing every filter on a workflow tab must not bring its saved filters back.
    expect(parse('?wf=wf_brown&view=board')).toMatchObject({ workflowId: 'wf_brown', explicit: true, query: DEFAULT_QUERY })
  })

  it('reads borough and neighborhood in any case, and ignores (with a plain note) what it does not know', () => {
    expect(parse('?borough=brooklyn&neighborhood=park%20slope').query.filters).toEqual({ borough: 'Brooklyn', neighborhood: 'Park Slope' })
    const bad = parse('?tier=scorching&units=6&lastContact=over5&taskDue=tomorrow&timeInGroup=10&view=list&sort=priority&dir=up&borough=Jersey&neighborhood=Atlantis&strongBuyer=maybe&utm_source=x')
    expect(bad.query).toEqual(DEFAULT_QUERY)
    expect(bad.ignored).toHaveLength(11)
    for (const note of bad.ignored) expect(note).toMatch(/^This link had /)
    expect(bad.ignored.join(' ')).not.toMatch(/utm_source/) // other parameters are none of the Pipeline's business
  })

  it('a malformed group id or workflow id is ignored with the same plain note', () => {
    const r = parse('?groups=g_hot,not%20an%20id!,g_nurture&wf=%3Cscript%3E')
    expect(r.query.groups).toEqual(['g_hot', 'g_nurture'])
    expect(r.workflowId).toBeNull()
    expect(r.ignored).toEqual([
      "This link had a group the Pipeline doesn't know (not an id!), so it was ignored.",
      "This link had a saved workflow the Pipeline doesn't know (<script>), so it was ignored.",
    ])
  })

  it('page numbers: whole numbers from 1 to 1,000,000; anything else is ignored with a note', () => {
    expect(parse('?view=table&page=1000000').query.page).toBe(1_000_000)
    expect(parse('?view=table&page=3')).toMatchObject({ query: { page: 3 }, ignored: [] })
    for (const bad of ['12345678901234567890', '1000001', '9007199254740993', '0', '-2', '2.5', '3abc']) {
      const r = parse(`?view=table&page=${bad}`)
      expect(r.query.page, bad).toBeUndefined()
      expect(r.ignored, bad).toEqual([`This link had a page number the Pipeline doesn't know (${bad}), so it was ignored.`])
    }
  })

  it("PR A's API parser: a page number too big for the database reads as page 1 (it used to answer 500)", () => {
    const page = (p: string) => parsePipelineQuery(new URLSearchParams(`view=table&page=${p}`)).page
    expect(page('12345678901234567890')).toBe(1)
    expect(page('9007199254740993')).toBe(1)
    expect(page('1000001')).toBe(1)
    expect(page('1000000')).toBe(1_000_000)
    expect(page('7')).toBe(7)
  })

  it('Brief 45 PR G: a value range in the link is read; the old single "value" parameter is left out with a note', () => {
    const r = parse('?value=1000000&valueMin=1&borough=Queens')
    expect(r.query.filters).toEqual({ borough: 'Queens', valueMin: '1' })
    expect(r.ignored).toEqual(["This link had a value filter the Pipeline doesn't know (1000000), so it was ignored."])
  })

  it('normalizes: rank ascending is the default sort, page 1 is no page, blank search is no search', () => {
    expect(normalizeQuery({ view: 'table', filters: { q: '   ' }, sort: 'rank', dir: 'asc', page: 1 })).toEqual({ view: 'table', filters: {} })
    expect(normalizeQuery({ view: 'table', filters: {}, dir: 'desc' })).toEqual({ view: 'table', filters: {}, sort: 'rank', dir: 'desc' })
    expect(normalizeQuery({ view: 'table', filters: {}, sort: 'name', dir: 'asc' })).toEqual({ view: 'table', filters: {}, sort: 'name' })
  })

  it('sameQuery ignores column order (columns always follow the sidebar) and defaults', () => {
    expect(sameQuery({ view: 'board', groups: ['a', 'b'], filters: {} }, { view: 'board', groups: ['b', 'a'], filters: {}, page: 1 })).toBe(true)
    expect(sameQuery({ view: 'board', filters: { tier: 'hot' } }, { view: 'board', filters: {} })).toBe(false)
    expect(sameQuery({ view: 'board', filters: {} }, { view: 'table', filters: {} })).toBe(false)
  })

  it('changing a filter goes back to page 1 and drops an empty value', () => {
    const q: PipelineQuery = { view: 'table', filters: { tier: 'hot' }, page: 4 }
    expect(withFilter(q, 'borough', 'Queens')).toEqual({ view: 'table', filters: { tier: 'hot', borough: 'Queens' } })
    expect(withFilter(q, 'tier', undefined)).toEqual({ view: 'table', filters: {} })
  })
})
