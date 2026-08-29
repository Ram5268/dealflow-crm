// Server-only by construction: imported solely from Server Components. The
// 'server-only' package is not a dependency here, so the boundary is a
// convention plus the `@/lib/prisma` import, which would fail in a client bundle.
import { prisma } from '@/lib/prisma'
import { compile, compileOrderBy, type CompileContext } from '@/lib/core-data/query-dsl/compiler'
import { execute } from '@/lib/core-data/query-dsl/executor'
import { sQuerySchema, sortSpecSchema } from '@/lib/core-data/query-dsl/schema'

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

/**
 * Resolve the lead ids a Smart View selects, via Agent A's query DSL.
 *
 * The DSL is the only thing that understands `sQuery`, so we run it for ids and
 * then re-read through Prisma to get one consistent row shape (and the contact
 * counts) rather than duplicating the SELECT list here.
 */
async function idsForView(organizationId: string, viewId: string): Promise<string[]> {
  const view = await prisma.savedView.findFirst({ where: { id: viewId, organizationId } })
  if (!view) throw new Error('Smart View not found')
  if (view.type !== 'lead') throw new Error(`Smart View type must be 'lead', got '${view.type}'`)

  const defs = await prisma.customFieldDefinition.findMany({
    where: { organizationId },
    select: { id: true, type: true },
  })
  const customFieldTypes = Object.fromEntries(
    defs.map((d) => [d.id, d.type]),
  ) as CompileContext['customFieldTypes']

  const compiled = compile(sQuerySchema.parse(view.sQuery), { organizationId, customFieldTypes })
  const rows = await execute<{ id: string }>(compiled, prisma, {
    organizationId,
    selectSql: 'lead.id',
    orderBySql: compileOrderBy(sortSpecSchema.parse(view.sort ?? [])),
    limit: 1000,
  })
  return rows.map((r) => r.id)
}

export async function listLeads(params: ListLeadsParams): Promise<ListLeadsResult> {
  const {
    organizationId,
    q,
    viewId,
    sortKey = 'updatedAt',
    sortDir = 'desc',
    page = 1,
    pageSize = DEFAULT_PAGE_SIZE,
  } = params

  let viewIds: string[] | null = null
  let viewError: string | undefined

  if (viewId) {
    try {
      viewIds = await idsForView(organizationId, viewId)
    } catch (err) {
      // A broken saved view must not blank the page — fall back to all leads
      // and surface the reason inline.
      viewError = err instanceof Error ? err.message : 'Smart View failed'
    }
  }

  const term = q?.trim()
  const where = {
    organizationId,
    ...(viewIds ? { id: { in: viewIds } } : {}),
    ...(term
      ? {
          OR: [
            { displayName: { contains: term, mode: 'insensitive' as const } },
            { primaryAddressSummary: { contains: term, mode: 'insensitive' as const } },
          ],
        }
      : {}),
  }

  // An empty Smart View result means "no matches", not "no filter".
  if (viewIds && viewIds.length === 0) {
    return { rows: [], total: 0, page, pageSize, viewError }
  }

  const [total, leads] = await Promise.all([
    prisma.lead.count({ where }),
    prisma.lead.findMany({
      where,
      orderBy: [leadOrderBy(sortKey, sortDir), { id: 'desc' }],
      skip: (page - 1) * pageSize,
      take: pageSize,
      include: { _count: { select: { contacts: true } } },
    }),
  ])

  return {
    rows: leads.map((l) => ({
      id: l.id,
      displayName: l.displayName,
      statusLabel: l.statusLabel,
      priorityScore: l.priorityScore,
      source: l.source,
      address: l.primaryAddressSummary,
      contactCount: l._count.contacts,
      updatedAt: l.updatedAt.toISOString(),
    })),
    total,
    page,
    pageSize,
    viewError,
  }
}
