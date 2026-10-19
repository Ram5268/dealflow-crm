// Server-only by construction: imported solely from Server Components. The
// 'server-only' package is not a dependency here, so the boundary is a
// convention plus the `@/lib/prisma` import, which would fail in a client bundle.
import type { Prisma, PrismaClient } from '@prisma/client'
import { prisma } from '@/lib/prisma'
import {
  compile,
  compileOrderBy,
  type CompileContext,
  type CompiledQuery,
} from '@/lib/core-data/query-dsl/compiler'
import { execute, executeCount } from '@/lib/core-data/query-dsl/executor'
import { parseSavedViewQuery, sortSpecSchema, type SortSpec, type SQuery } from '@/lib/core-data/query-dsl/schema'
import { compliancePredicatesIn, DNC_CLEAN_NOTE } from '@/lib/core-data/query-dsl/compliance-filters'
import { getRankedPage } from '@/lib/core-data/lists/ranked'
import { isGroupColor } from '@/lib/core-data/lists/rules'
import { MAX_PAGE, type GroupColor, type MemberFilters } from '@/lib/core-data/lists/types'

export const LEAD_SORT_KEYS = ['displayName', 'statusLabel', 'priorityScore', 'updatedAt'] as const
export type LeadSortKey = (typeof LEAD_SORT_KEYS)[number]

/**
 * Prisma rejects `nulls: 'last'` on a NON-nullable column, so the option can
 * only be attached to the sort keys whose columns are actually nullable.
 * `displayName` and `updatedAt` are required in the schema.
 */
const NULLABLE_SORT_KEYS = new Set<LeadSortKey>(['statusLabel', 'priorityScore'])

function leadOrderBy(sortKey: LeadSortKey, sortDir: 'asc' | 'desc') {
  return NULLABLE_SORT_KEYS.has(sortKey)
    ? { [sortKey]: { sort: sortDir, nulls: 'last' as const } }
    : { [sortKey]: sortDir }
}

export function isLeadSortKey(v: string | undefined): v is LeadSortKey {
  return !!v && (LEAD_SORT_KEYS as readonly string[]).includes(v)
}

export interface LeadRow {
  id: string
  displayName: string
  statusLabel: string | null
  priorityScore: number | null
  source: string | null
  address: string | null
  contactCount: number
  updatedAt: string
  /** Brief 45: the person's place in All leads. Set only in rank order (no Smart View, no column). */
  rank?: number
}

export interface ListLeadsParams {
  organizationId: string
  q?: string
  viewId?: string
  /** A column the user chose. Without one, a Smart View uses its own saved sort. */
  sortKey?: LeadSortKey
  sortDir?: 'asc' | 'desc'
  page?: number
  /** Ignored in rank order, which pages 100 at a time like every list. */
  pageSize?: number
  /**
   * Brief 45: a group id (or 'none' for people in no group). Narrows All leads
   * in rank order or under a column sort; a Smart View ignores it.
   */
  group?: string
}

/** The order the page was listed in, so the grid can mark the sorted column. */
export interface AppliedSort {
  /** null when the view sorts by something that isn't a grid column. */
  key: LeadSortKey | null
  dir: 'asc' | 'desc'
  /** true when the order is the Smart View's own saved sort, not a column click. */
  fromView: boolean
  /**
   * Brief 45: true when the page is in the lists' rank order (no Smart View,
   * no column): DealFlow priority, then best buyer fit, then fewer call
   * attempts, then who was added first (CONTRACT §3).
   */
  ranked?: boolean
}

/** Brief 45: the group the page is narrowed to (?group=), for its "Group: Hot" chip. */
export interface AppliedGroup {
  id: string
  name: string
  color: GroupColor
}

export interface ListLeadsResult {
  rows: LeadRow[]
  total: number
  page: number
  pageSize: number
  sort: AppliedSort
  /** Set when a Smart View could not be applied, so the UI can say why. */
  viewError?: string
  /**
   * Brief 50 PR 4: what an applied Smart View's "Do-not-call clean" filter
   * means, shown above the list (so an empty view isn't a mystery).
   */
  viewNote?: string
  /** Brief 45: the group filter that was applied, else null. */
  group?: AppliedGroup | null
  /** Brief 45: set when ?group= names a group that doesn't exist (here). */
  groupError?: string
  /** Brief 45: when DealFlow's morning ranking was copied in (rank order only). */
  rankedAt?: string | null
}

export const GROUP_GONE = 'That group no longer exists. Showing all leads.'
const NO_GROUP: AppliedGroup = { id: 'none', name: 'In no group', color: 'gray' }

const DEFAULT_PAGE_SIZE = 50

const ROW_INCLUDE = { _count: { select: { contacts: true } } } as const

function toRow(l: Prisma.LeadGetPayload<{ include: typeof ROW_INCLUDE }>): LeadRow {
  return {
    id: l.id,
    displayName: l.displayName,
    statusLabel: l.statusLabel,
    priorityScore: l.priorityScore,
    source: l.source,
    address: l.primaryAddressSummary,
    contactCount: l._count.contacts,
    updatedAt: l.updatedAt.toISOString(),
  }
}

// The search box as a DSL condition, so it can join a Smart View's filter in SQL.
function searchQuery(term: string): SQuery {
  const contains = (column: string): SQuery => ({
    type: 'field_condition',
    field: { kind: 'regular', table: 'lead', column },
    condition: { type: 'text', mode: 'contains', value: term },
  })
  return { type: 'or', queries: [contains('displayName'), contains('primaryAddressSummary')] }
}

/**
 * Compile a Smart View, plus the search box, into one org-scoped SQL filter via
 * Agent A's query DSL (the only thing that understands `sQuery`). Also returns
 * the view's saved sort.
 */
async function compileView(
  db: PrismaClient,
  organizationId: string,
  viewId: string,
  term: string | undefined,
): Promise<{ compiled: CompiledQuery; viewSort: SortSpec; viewNote?: string }> {
  const view = await db.savedView.findFirst({ where: { id: viewId, organizationId } })
  if (!view) throw new Error('Smart View not found')
  if (view.type !== 'lead') throw new Error(`Smart View type must be 'lead', got '${view.type}'`)

  const defs = await db.customFieldDefinition.findMany({
    where: { organizationId },
    select: { id: true, type: true },
  })
  const customFieldTypes = Object.fromEntries(
    defs.map((d) => [d.id, d.type]),
  ) as CompileContext['customFieldTypes']

  // Brief 50 PR 4: a view saved with the hidden "Callable now" filter throws a
  // plain UnavailableFilterError here, which the page shows (viewError).
  const viewQuery = parseSavedViewQuery(view.sQuery)
  const query: SQuery = term ? { type: 'and', queries: [viewQuery, searchQuery(term)] } : viewQuery
  return {
    compiled: compile(query, { organizationId, customFieldTypes }),
    viewSort: sortSpecSchema.parse(view.sort ?? []),
    viewNote: compliancePredicatesIn(viewQuery).includes('dnc_clean') ? DNC_CLEAN_NOTE : undefined,
  }
}

// What the grid shows as sorted when the view's own sort is in charge. An empty
// saved sort means compileOrderBy's default, priority first.
function viewSortState(viewSort: SortSpec): AppliedSort {
  const first = viewSort[0] ?? { field: 'priorityScore', direction: 'desc' as const }
  return { key: isLeadSortKey(first.field) ? first.field : null, dir: first.direction, fromView: true }
}

/**
 * One page of a Smart View. The filter, the sort and the paging all run in SQL,
 * and the total is the real count, so a view of any size pages completely.
 * (Brief 41: this used to fetch the view's first 1,000 ids and page inside
 * them, so bigger views silently lost leads.) The order is the column the user
 * chose, else the view's own saved sort ("DealFlow priority" = best first).
 * compileOrderBy ends on lead.id, so rows that tie keep one order across pages
 * and reloads. The page's rows are then re-read through Prisma for one
 * consistent row shape (and the contact counts) rather than duplicating the
 * SELECT list here.
 */
async function listViewPage(
  db: PrismaClient,
  args: {
    organizationId: string
    viewId: string
    term: string | undefined
    sortKey: LeadSortKey | undefined
    sortDir: 'asc' | 'desc'
    page: number
    pageSize: number
  },
): Promise<{ rows: LeadRow[]; total: number; sort: AppliedSort; viewNote?: string }> {
  const { organizationId, viewId, term, sortKey, sortDir, page, pageSize } = args
  const { compiled, viewSort, viewNote } = await compileView(db, organizationId, viewId, term)
  // A chosen column leads; the view's own saved sort still breaks its ties.
  const orderSpec: SortSpec = sortKey
    ? [{ field: sortKey, direction: sortDir }, ...viewSort.filter((s) => s.field !== sortKey)]
    : viewSort
  const sort: AppliedSort = sortKey ? { key: sortKey, dir: sortDir, fromView: false } : viewSortState(viewSort)
  const [idRows, total] = await Promise.all([
    execute<{ id: string }>(compiled, db, {
      organizationId,
      selectSql: 'lead.id',
      orderBySql: compileOrderBy(orderSpec),
      limit: pageSize,
      offset: (page - 1) * pageSize,
    }),
    executeCount(compiled, db, organizationId),
  ])
  if (idRows.length === 0) return { rows: [], total, sort, viewNote }

  const leads = await db.lead.findMany({
    where: { organizationId, id: { in: idRows.map((r) => r.id) } },
    include: ROW_INCLUDE,
  })
  const byId = new Map(leads.map((l) => [l.id, l]))
  return {
    rows: idRows.flatMap((r) => {
      const lead = byId.get(r.id)
      return lead ? [toRow(lead)] : []
    }),
    total,
    sort,
    viewNote,
  }
}

/** The ?group= filter, checked against this organization's groups. */
async function resolveGroup(
  db: PrismaClient,
  organizationId: string,
  group: string | undefined,
): Promise<{ group: AppliedGroup | null; groupError?: string }> {
  if (!group) return { group: null }
  if (group === 'none') return { group: NO_GROUP }
  const g = await db.leadGroup.findFirst({ where: { id: group, organizationId }, select: { id: true, name: true, color: true } })
  return g ? { group: { id: g.id, name: g.name, color: isGroupColor(g.color) ? g.color : 'gray' } } : { group: null, groupError: GROUP_GONE }
}

/**
 * Brief 45: All leads in the same rank order as every list (CONTRACT §3),
 * computed by the lists' own ranked query over every lead, 100 a page. Each
 * row's rank is its place in All leads; search and the group filter narrow
 * the page without changing anyone's number [brief §5.4]. The page's rows are
 * then read through Prisma for the grid's usual row shape.
 */
async function listRankedPage(
  db: PrismaClient,
  args: { organizationId: string; term: string | undefined; group: AppliedGroup | null; page: number },
): Promise<{ rows: LeadRow[]; total: number; pageSize: number; rankedAt: string | null }> {
  const filters: MemberFilters = {
    ...(args.term ? { q: args.term } : {}),
    ...(args.group ? { group: args.group.id } : {}),
  }
  const ranked = await getRankedPage(args.organizationId, null, { page: args.page, filters }, db)
  const base = { total: ranked.total, pageSize: ranked.pageSize, rankedAt: ranked.rankedAt }
  if (ranked.rows.length === 0) return { rows: [], ...base }
  const leads = await db.lead.findMany({
    where: { organizationId: args.organizationId, id: { in: ranked.rows.map((r) => r.leadId) } },
    include: ROW_INCLUDE,
  })
  const byId = new Map(leads.map((l) => [l.id, l]))
  return {
    rows: ranked.rows.flatMap((r) => {
      const lead = byId.get(r.leadId)
      return lead ? [{ ...toRow(lead), rank: r.rank }] : []
    }),
    ...base,
  }
}

export async function listLeads(params: ListLeadsParams, db: PrismaClient = prisma): Promise<ListLeadsResult> {
  const {
    organizationId,
    q,
    viewId,
    sortKey: chosenSortKey,
    sortDir: chosenSortDir,
    pageSize = DEFAULT_PAGE_SIZE,
  } = params
  // Brief 45: 1 to MAX_PAGE, else 1. A bigger page would overflow the
  // database's OFFSET [engineering precaution]; the page parses it the same way.
  const page = Number.isSafeInteger(params.page) && params.page! >= 1 && params.page! <= MAX_PAGE ? params.page! : 1

  const term = q?.trim() || undefined
  let viewError: string | undefined

  if (viewId) {
    try {
      const { rows, total, sort, viewNote } = await listViewPage(db, {
        organizationId,
        viewId,
        term,
        sortKey: chosenSortKey,
        sortDir: chosenSortDir ?? 'desc',
        page,
        pageSize,
      })
      // A Smart View has its own filter; the group filter doesn't apply to it.
      return { rows, total, page, pageSize, sort, group: null, viewNote }
    } catch (err) {
      // A broken saved view must not blank the page — fall back to all leads
      // and surface the reason inline.
      viewError = err instanceof Error ? err.message : 'Smart View failed'
    }
  }

  const { group, groupError } = await resolveGroup(db, organizationId, params.group)

  // Brief 45: with no column chosen, All leads is in the lists' rank order.
  // (It used to be most recently updated first.)
  if (!chosenSortKey) {
    const ranked = await listRankedPage(db, { organizationId, term, group, page })
    return {
      rows: ranked.rows,
      total: ranked.total,
      page,
      pageSize: ranked.pageSize,
      sort: { key: null, dir: 'asc', fromView: false, ranked: true },
      viewError,
      group,
      groupError,
      rankedAt: ranked.rankedAt,
    }
  }

  const sortKey = chosenSortKey
  const sortDir = chosenSortDir ?? 'desc'
  const where = {
    organizationId,
    ...(term
      ? {
          OR: [
            { displayName: { contains: term, mode: 'insensitive' as const } },
            { primaryAddressSummary: { contains: term, mode: 'insensitive' as const } },
          ],
        }
      : {}),
    // Brief 45: ?group= (its id was checked against this organization above).
    ...(group?.id === NO_GROUP.id
      ? { groupMemberships: { none: {} } }
      : group
        ? { groupMemberships: { some: { groupId: group.id } } }
        : {}),
  }

  const [total, leads] = await Promise.all([
    db.lead.count({ where }),
    db.lead.findMany({
      where,
      // The same order a Smart View with no saved sort uses (compileOrderBy):
      // the chosen column, blanks last, then id.
      orderBy: [leadOrderBy(sortKey, sortDir), { id: 'asc' }],
      skip: (page - 1) * pageSize,
      take: pageSize,
      include: ROW_INCLUDE,
    }),
  ])

  return {
    rows: leads.map(toRow),
    total,
    page,
    pageSize,
    sort: { key: sortKey, dir: sortDir, fromView: false },
    viewError,
    group,
    groupError,
  }
}
