// Brief 45 PR D — the Pipeline page's address. Every filter, the columns, the
// board/table choice, the table's sort and page, and the open workflow tab
// live in the URL [brief §5.6], so a view can be bookmarked or shared and
// Back/Forward work. The parameters are PR A's API parameters (CONTRACT §6b),
// so the same string means the same thing to the page and to the API.
//
// Reading is lenient: a link with a value the Pipeline doesn't know still
// opens, without it, and says so in plain English (the API, by contrast,
// answers 400). Client-safe: no Prisma.
import {
  BOROUGHS, PIPELINE_FILTER_KEYS, PIPELINE_SORT_KEYS, PIPELINE_VIEWS,
  type PipelineFilters, type PipelineQuery, type SortDir,
} from '@/lib/core-data/lists/types'
import { NEIGHBORHOODS, cleanText } from '@/lib/core-data/lists/geo'

export const PIPELINE_PATH = '/pipeline'

/** Every group as a column, on the board, no filters. */
export const DEFAULT_QUERY: PipelineQuery = { view: 'board', filters: {} }

export const UNITS = ['1', '2', '3', '4', '5+'] as const
export const TIERS = ['hot', 'warm', 'possible', 'none'] as const
export const LAST_CONTACT = ['never', 'over7', 'over30', 'over60', 'over90'] as const
export const TASK_DUE = ['today', 'week', 'overdue'] as const
export const TIME_IN_GROUP = ['30', '60', '90'] as const

/** PR A's words, so the page and the API say the same thing. */
export const VALUE_FILTER_NOTE = "Filtering by value isn't available yet: our estimates aren't in the CRM."
const VALUE_KEYS = ['value', 'valueMin', 'valueMax']

// Ids are cuids; anything else in an id slot is ignored.
const ID = /^[A-Za-z0-9_-]{1,64}$/

/** The parameters that describe what's on screen (anything besides `wf`). */
const STATE_KEYS: readonly string[] = ['view', 'groups', ...PIPELINE_FILTER_KEYS, 'sort', 'dir', 'page']

// How each parameter is named in a "this link had …" note.
const WHAT: Record<string, string> = {
  view: 'a view', list: 'a list', folder: 'a folder', borough: 'a borough', neighborhood: 'a neighborhood',
  propertyType: 'a property type', units: 'a unit count', tier: 'a DealFlow tier', strongBuyer: 'a strong-buyer setting',
  lastContact: 'a last-contact filter', taskDue: 'a task filter', timeInGroup: 'a time-in-group filter',
  multiGroup: 'a multi-group setting', sort: 'a sort', dir: 'a sort direction',
}
const ignoredNote = (key: string, value: string) =>
  `This link had ${WHAT[key]} the Pipeline doesn't know (${value.slice(0, 40)}), so it was ignored.`

export interface PipelineUrlState {
  query: PipelineQuery
  /** The saved workflow whose tab is open; null = the "All groups" tab. */
  workflowId: string | null
}

export interface ParsedPipelineUrl extends PipelineUrlState {
  /**
   * True when the link says what's on screen (anything besides `wf`). A bare
   * `?wf=<id>` (a tab, or the sidebar's Workflows link) opens the workflow as
   * saved; the page always writes `view` next to `wf`, so clearing every
   * filter on a workflow tab doesn't bring its saved filters back.
   */
  explicit: boolean
  /** Plain-English notes about parts of the link that were ignored. */
  ignored: string[]
}

type Search = URLSearchParams | Record<string, string | string[] | undefined>

function toParams(input: Search): URLSearchParams {
  if (input instanceof URLSearchParams) return input
  const sp = new URLSearchParams()
  for (const [k, v] of Object.entries(input)) {
    const first = Array.isArray(v) ? v[0] : v
    if (typeof first === 'string') sp.set(k, first)
  }
  return sp
}

export function parsePipelineUrl(input: Search): ParsedPipelineUrl {
  const sp = toParams(input)
  const ignored: string[] = []
  const get = (key: string) => sp.get(key)?.trim() || undefined
  const oneOf = <T extends string>(key: string, allowed: readonly T[]): T | undefined => {
    const v = get(key)
    if (v === undefined) return undefined
    if ((allowed as readonly string[]).includes(v)) return v as T
    ignored.push(ignoredNote(key, v))
    return undefined
  }
  const named = (key: string, names: readonly string[]): string | undefined => {
    const v = get(key)
    if (v === undefined) return undefined
    const hit = names.find((n) => n.toLowerCase() === v.toLowerCase())
    if (!hit) ignored.push(ignoredNote(key, v))
    return hit
  }
  const id = (key: string): string | undefined => {
    const v = get(key)
    if (v === undefined) return undefined
    if (ID.test(v)) return v
    ignored.push(ignoredNote(key, v))
    return undefined
  }
  const flag = (key: string): '1' | undefined => {
    const v = get(key)
    if (v === undefined || v === '0' || v === 'false') return undefined
    if (v === '1' || v === 'true') return '1'
    ignored.push(ignoredNote(key, v))
    return undefined
  }

  const view = oneOf('view', PIPELINE_VIEWS) ?? 'board'
  const groups = get('groups')?.split(',').map((g) => g.trim()).filter((g) => ID.test(g))
  const filters: PipelineFilters = {
    list: id('list'),
    folder: id('folder'),
    borough: named('borough', BOROUGHS),
    neighborhood: named('neighborhood', NEIGHBORHOODS),
  }
  const propertyType = get('propertyType')
  if (propertyType !== undefined) {
    if (propertyType.length <= 200) filters.propertyType = cleanText(propertyType)
    else ignored.push(ignoredNote('propertyType', propertyType))
  }
  Object.assign(filters, {
    units: oneOf('units', UNITS),
    tier: oneOf('tier', TIERS),
    strongBuyer: flag('strongBuyer'),
    lastContact: oneOf('lastContact', LAST_CONTACT),
    taskDue: oneOf('taskDue', TASK_DUE),
    timeInGroup: oneOf('timeInGroup', TIME_IN_GROUP),
    multiGroup: flag('multiGroup'),
    q: get('q')?.slice(0, 200),
  } satisfies PipelineFilters)
  const sort = oneOf('sort', PIPELINE_SORT_KEYS)
  const dir = oneOf<SortDir>('dir', ['asc', 'desc'])
  const page = Number.parseInt(get('page') ?? '', 10)
  if (VALUE_KEYS.some((k) => sp.has(k))) ignored.push(VALUE_FILTER_NOTE)

  const wf = get('wf')
  return {
    query: normalizeQuery({ view, groups, filters, sort, dir, page: Number.isInteger(page) ? page : undefined }),
    workflowId: wf && ID.test(wf) ? wf : null,
    explicit: STATE_KEYS.some((k) => sp.has(k)),
    ignored,
  }
}

/** Only the filters that are set, in a fixed order; search trimmed. */
function cleanFilters(f: PipelineFilters): PipelineFilters {
  const out: Record<string, string> = {}
  for (const key of PIPELINE_FILTER_KEYS) {
    const v = f[key]
    if (typeof v === 'string' && v.trim() !== '') out[key] = key === 'q' ? v.trim() : v
  }
  return out as PipelineFilters
}

/**
 * The one way to write a query: defaults left out (every group, rank order
 * ascending, page 1), so two queries that show the same thing compare equal.
 * The page never carries PR A's `column` (that's for "load more").
 */
export function normalizeQuery(q: PipelineQuery): PipelineQuery {
  const out: PipelineQuery = { view: q.view, filters: cleanFilters(q.filters) }
  const groups = [...new Set((q.groups ?? []).filter(Boolean))]
  if (groups.length > 0) out.groups = groups
  let sort = q.sort
  const dir: SortDir | undefined = q.dir === 'desc' ? 'desc' : undefined
  if (!sort && dir) sort = 'rank'
  if (sort === 'rank' && !dir) sort = undefined
  if (sort) out.sort = sort
  if (dir) out.dir = dir
  if (q.page && q.page > 1) out.page = q.page
  return out
}

export function pipelineSearch({ query, workflowId }: PipelineUrlState): string {
  const q = normalizeQuery(query)
  const sp = new URLSearchParams()
  if (workflowId) sp.set('wf', workflowId)
  if (q.view !== 'board' || workflowId) sp.set('view', q.view)
  if (q.groups) sp.set('groups', q.groups.join(','))
  for (const key of PIPELINE_FILTER_KEYS) {
    const v = q.filters[key]
    if (v) sp.set(key, v)
  }
  if (q.sort) sp.set('sort', q.sort)
  if (q.dir) sp.set('dir', q.dir)
  if (q.page) sp.set('page', String(q.page))
  const s = sp.toString()
  return s ? `?${s}` : ''
}

export function pipelineHref(state: PipelineUrlState): string {
  return PIPELINE_PATH + pipelineSearch(state)
}

/** Same view? Column order doesn't matter: columns always follow the sidebar. */
export function sameQuery(a: PipelineQuery, b: PipelineQuery): boolean {
  const x = normalizeQuery(a)
  const y = normalizeQuery(b)
  const groups = (q: PipelineQuery) => [...(q.groups ?? [])].sort().join(',')
  return (
    x.view === y.view && x.sort === y.sort && x.dir === y.dir && x.page === y.page && groups(x) === groups(y) &&
    PIPELINE_FILTER_KEYS.every((k) => x.filters[k] === y.filters[k])
  )
}

/** Set (or, with undefined, clear) one filter; back to page 1. */
export function withFilter<K extends keyof PipelineFilters>(q: PipelineQuery, key: K, value: PipelineFilters[K] | undefined): PipelineQuery {
  return withFilters(q, { [key]: value } as Partial<PipelineFilters>)
}

export function withFilters(q: PipelineQuery, patch: Partial<PipelineFilters>): PipelineQuery {
  return normalizeQuery({ ...q, filters: { ...q.filters, ...patch }, page: undefined })
}

/** The filters set in the panel (search is the box above it, so it isn't counted). */
export function panelFilterCount(f: PipelineFilters): number {
  return PIPELINE_FILTER_KEYS.filter((k) => k !== 'q' && f[k]).length
}
