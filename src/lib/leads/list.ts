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
import { sQuerySchema, type SQuery } from '@/lib/core-data/query-dsl/schema'

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
}

export interface ListLeadsParams {
  organizationId: string
  q?: string
  viewId?: string
  sortKey?: LeadSortKey
  sortDir?: 'asc' | 'desc'
  page?: number
  pageSize?: number
}

export interface ListLeadsResult {
  rows: LeadRow[]
  total: number
  page: number
  pageSize: number
  /** Set when a Smart View could not be applied, so the UI can say why. */
  viewError?: string
}

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
 * Agent A's query DSL (the only thing that understands `sQuery`).
 */
async function compileView(
  db: PrismaClient,
  organizationId: string,
  viewId: string,
  term: string | undefined,
): Promise<CompiledQuery> {
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

  const viewQuery = sQuerySchema.parse(view.sQuery)
  const query: SQuery = term ? { type: 'and', queries: [viewQuery, searchQuery(term)] } : viewQuery
  return compile(query, { organizationId, customFieldTypes })
}

/**
 * One page of a Smart View. The filter, the sort and the paging all run in SQL,
 * and the total is the real count, so a view of any size pages completely.
 * (Brief 41: this used to fetch the view's first 1,000 ids and page inside
 * them, so bigger views silently lost leads.) compileOrderBy ends on lead.id,
 * so rows that tie on the sort column keep one order across pages and reloads.
 * The page's rows are then re-read through Prisma for one consistent row shape
 * (and the contact counts) rather than duplicating the SELECT list here.
 */
async function listViewPage(
  db: PrismaClient,
  args: {
    organizationId: string
    viewId: string
    term: string | undefined
    sortKey: LeadSortKey
    sortDir: 'asc' | 'desc'
    page: number
    pageSize: number
  },
): Promise<{ rows: LeadRow[]; total: number }> {
  const { organizationId, viewId, term, sortKey, sortDir, page, pageSize } = args
  const compiled = await compileView(db, organizationId, viewId, term)
  const [idRows, total] = await Promise.all([
    execute<{ id: string }>(compiled, db, {
      organizationId,
      selectSql: 'lead.id',
      orderBySql: compileOrderBy([{ field: sortKey, direction: sortDir }]),
      limit: pageSize,
      offset: (page - 1) * pageSize,
    }),
    executeCount(compiled, db, organizationId),
  ])
  if (idRows.length === 0) return { rows: [], total }

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
  }
}

export async function listLeads(params: ListLeadsParams, db: PrismaClient = prisma): Promise<ListLeadsResult> {
  const {
    organizationId,
    q,
    viewId,
    sortKey = 'updatedAt',
    sortDir = 'desc',
    page = 1,
    pageSize = DEFAULT_PAGE_SIZE,
  } = params

  const term = q?.trim() || undefined
  let viewError: string | undefined

  if (viewId) {
    try {
      const { rows, total } = await listViewPage(db, {
        organizationId,
        viewId,
        term,
        sortKey,
        sortDir,
        page,
        pageSize,
      })
      return { rows, total, page, pageSize }
    } catch (err) {
      // A broken saved view must not blank the page — fall back to all leads
      // and surface the reason inline.
      viewError = err instanceof Error ? err.message : 'Smart View failed'
    }
  }

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
  }

  const [total, leads] = await Promise.all([
    db.lead.count({ where }),
    db.lead.findMany({
      where,
      // The same order a Smart View page uses (compileOrderBy): the chosen
      // column, blanks last, then id.
      orderBy: [leadOrderBy(sortKey, sortDir), { id: 'asc' }],
      skip: (page - 1) * pageSize,
      take: pageSize,
      include: ROW_INCLUDE,
    }),
  ])

  return { rows: leads.map(toRow), total, page, pageSize, viewError }
}
