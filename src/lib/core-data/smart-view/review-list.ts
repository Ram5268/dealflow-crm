import { prisma } from '@/lib/prisma'
import { HttpError } from '@/lib/shared/http'
import { compile } from '@/lib/core-data/query-dsl/compiler'
import { execute, executeCount } from '@/lib/core-data/query-dsl/executor'
import { parseSavedViewQuery, sortSpecSchema, UnavailableFilterError, type SQuery } from '@/lib/core-data/query-dsl/schema'
import { loadCustomFieldTypes, queueOrder } from './queue-service'
import { HAS_DEALFLOW_PRIORITY } from './defaultView'
import { bestBuyerLookup } from '@/lib/core-data/dealflow-sync/buyer-lookup'
import type { DealflowBuyer } from '@/lib/core-data/dealflow-sync/buyers'

// Brief 37 — the /queue review list, used only while calling is off: a view's
// ranked leads in order, WITHOUT the callable-now scrub. Display-only: it selects
// no phone numbers and feeds no dial session, placeCall, SMS or email path (the
// dialer always uses getQueue). Leads with no DealFlow priority never appear.

const REVIEW_CAP = 2_000

// No phone numbers, on purpose.
export const REVIEW_SELECT =
  'lead.id AS "leadId", lead."displayName", lead."primaryAddressSummary", lead."priorityScore", ' +
  'lead."topMatchFit", lead."matchReason", lead."dealflowDeepLink", lead."mojoId"'

export interface ReviewLead {
  leadId: string
  displayName: string
  primaryAddressSummary: string | null
  priorityScore: number | null
  topMatchFit: number | null
  matchReason: string | null
  dealflowDeepLink: string | null
  mojoId: string | null
  bestBuyer: DealflowBuyer | null // Brief 38
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

// A saved view's query. Brief 50 PR 4: a view saved with the hidden "Callable
// now" filter is refused with its plain message (400) rather than listed as if
// the filter applied.
function savedViewQuery(raw: unknown): SQuery {
  try {
    return parseSavedViewQuery(raw)
  } catch (err) {
    // The Queue page shows the message on its own, so it gets its full stop here.
    if (err instanceof UnavailableFilterError) throw new HttpError(400, `${err.message}.`)
    throw err
  }
}

export async function getReviewList(viewId: string, organizationId: string): Promise<ReviewList> {
  const view = await prisma.savedView.findFirst({ where: { id: viewId, organizationId } })
  if (!view) throw new HttpError(404, 'SavedView not found')
  if (view.type !== 'lead') throw new HttpError(400, `SavedView type must be 'lead', got '${view.type}'`)

  const customFieldTypes = await loadCustomFieldTypes(organizationId)
  const compiled = compile(reviewQuery(savedViewQuery(view.sQuery)), { organizationId, customFieldTypes })
  // The Queue's order: DealFlow's rank (Brief 50 PR 10, queue-service.ts queueOrder).
  const ordered = queueOrder(compiled, sortSpecSchema.parse(view.sort ?? []), organizationId)
  const [leads, total, bestBuyer] = await Promise.all([
    execute<Omit<ReviewLead, 'bestBuyer'>>(ordered.compiled, prisma, { organizationId, selectSql: REVIEW_SELECT, orderBySql: ordered.orderBySql, limit: REVIEW_CAP }),
    executeCount(compiled, prisma, organizationId),
    bestBuyerLookup(organizationId),
  ])
  return { view: { id: view.id, name: view.name }, leads: leads.map((l) => ({ ...l, bestBuyer: bestBuyer(l) })), total }
}
