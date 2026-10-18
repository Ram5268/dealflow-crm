// Brief 45 — a list page's filters live in the URL (shareable, back button
// works): ?q=&group=<id>|none&strongBuyer=1&calledToday=1&borough=&page=.
// They narrow the list but never change its order or anyone's rank number
// [brief §5.4]. Pure: the server page reads with parseListSearch, the browser
// writes with listSearchString.
import { BOROUGHS, type MemberFilters } from '@/lib/core-data/lists/types'
import { pageParam } from '@/lib/ui/pageParam'

type Param = string | string[] | undefined

export interface ListSearch {
  q?: Param
  group?: Param
  strongBuyer?: Param
  calledToday?: Param
  borough?: Param
  page?: Param
}

const first = (v: Param) => (Array.isArray(v) ? v[0] : v)
const on = (v: Param) => ['1', 'true'].includes(first(v)?.trim() ?? '')

/**
 * Tolerant: an unknown borough or a bad page number (unreadable, or past
 * MAX_PAGE) is ignored rather than an error. "Called today" counts only while
 * calling is on; while it's off the filter is greyed out and never applied
 * [brief §5.1 rule 3].
 */
export function parseListSearch(sp: ListSearch, opts: { callingOn: boolean }): { page: number; filters: MemberFilters } {
  const filters: MemberFilters = {}
  const q = first(sp.q)?.trim()
  if (q) filters.q = q.slice(0, 200)
  const group = first(sp.group)?.trim()
  if (group) filters.group = group.slice(0, 100)
  if (on(sp.strongBuyer)) filters.strongBuyer = true
  if (opts.callingOn && on(sp.calledToday)) filters.calledToday = true
  const borough = first(sp.borough)?.trim().toLowerCase()
  const canonical = BOROUGHS.find((b) => b.toLowerCase() === borough)
  if (canonical) filters.borough = canonical
  return { page: pageParam(sp.page), filters }
}

/** "?q=…&group=…&strongBuyer=1&borough=…&page=3" — only what is set; page 1 is left out. */
export function listSearchString(filters: MemberFilters, page = 1): string {
  const sp = new URLSearchParams()
  if (filters.q) sp.set('q', filters.q)
  if (filters.group) sp.set('group', filters.group)
  if (filters.strongBuyer) sp.set('strongBuyer', '1')
  if (filters.calledToday) sp.set('calledToday', '1')
  if (filters.borough) sp.set('borough', filters.borough)
  if (page > 1) sp.set('page', String(page))
  const s = sp.toString()
  return s ? `?${s}` : ''
}
