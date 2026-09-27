import { prisma } from '@/lib/prisma'
import { HttpError } from '@/lib/shared/http'
import { compile, compileOrderBy } from '@/lib/core-data/query-dsl/compiler'
import { execute, executeCount } from '@/lib/core-data/query-dsl/executor'
import { sQuerySchema, sortSpecSchema, type SQuery } from '@/lib/core-data/query-dsl/schema'
import { loadCustomFieldTypes } from './queue-service'
import { HAS_DEALFLOW_PRIORITY } from './defaultView'

// Brief 37 — the /queue review list, used only while calling is off: a view's
// ranked leads in order, WITHOUT the callable-now scrub. Display-only: it selects
// no phone numbers and feeds no dial session, placeCall, SMS or email path (the
// dialer always uses getQueue). Leads with no DealFlow priority never appear.

const REVIEW_CAP = 2_000

// No phone numbers, on purpose.
export const REVIEW_SELECT =
  'lead.id AS "leadId", lead."displayName", lead."primaryAddressSummary", lead."priorityScore", ' +
  'lead."topMatchFit", lead."matchReason", lead."dealflowDeepLink"'

export interface ReviewLead {
  leadId: string
  displayName: string
  primaryAddressSummary: string | null
  priorityScore: number | null
  topMatchFit: number | null
  matchReason: string | null
  dealflowDeepLink: string | null
}

export interface ReviewList {
  view: { id: string; name: string }
  leads: ReviewLead[]
  total: number
}

// The view's own query AND "has a DealFlow priority".
export function reviewQuery(viewQuery: SQuery): SQuery {
  return { type: 'and', queries: [viewQuery, HAS_DEALFLOW_PRIORITY] }
}

export async function getReviewList(viewId: string, organizationId: string): Promise<ReviewList> {
  const view = await prisma.savedView.findFirst({ where: { id: viewId, organizationId } })
  if (!view) throw new HttpError(404, 'SavedView not found')
  if (view.type !== 'lead') throw new HttpError(400, `SavedView type must be 'lead', got '${view.type}'`)

  const customFieldTypes = await loadCustomFieldTypes(organizationId)
  const compiled = compile(reviewQuery(sQuerySchema.parse(view.sQuery)), { organizationId, customFieldTypes })
  const orderBySql = compileOrderBy(sortSpecSchema.parse(view.sort ?? []))
  const [leads, total] = await Promise.all([
    execute<ReviewLead>(compiled, prisma, { organizationId, selectSql: REVIEW_SELECT, orderBySql, limit: REVIEW_CAP }),
    executeCount(compiled, prisma, organizationId),
  ])
  return { view: { id: view.id, name: view.name }, leads, total }
}
