import { prisma } from '@/lib/prisma'
import { HttpError } from '@/lib/shared/http'
import { rankingTimesSql } from '@/lib/core-data/lists/sql'
import { compile, compileOrderBy, type CompileContext, type CompiledQuery } from '@/lib/core-data/query-dsl/compiler'
import { execute } from '@/lib/core-data/query-dsl/executor'
import {
  checkCallable,
  type BatchCaller,
  type CallableEntry,
} from '@/lib/core-data/query-dsl/compliance-bridge'
import { sQuerySchema, sortSpecSchema, type SortSpec } from '@/lib/core-data/query-dsl/schema'

// ─────────────────────────────────────────────────────────────────────────────
// queue-service — resolves a SavedView into the ranked, pre-scrubbed call queue.
// Implements the brief §7 mandatory behavior: primacy resolution, UNCONDITIONAL
// compliance scrub, fail-closed exclusion, split timezone semantics, sort, top-N.
// Pure helpers (primacy + timezone) are exported for unit tests; getQueue is the
// DB + compliance orchestrator.
// ─────────────────────────────────────────────────────────────────────────────

export const DISPLAY_TZ_FALLBACK = 'America/New_York'
const CANDIDATE_POOL_CAP = 1_000
const DEALFLOW_STALE_MS = 24 * 60 * 60 * 1000

export interface PhoneLike {
  id: string
  phone: string
  phoneFormatted?: string | null
  isPrimary: boolean
  createdAt: Date
}
export interface ContactLike {
  id: string
  timezone: string | null
  createdAt: Date
  phones: PhoneLike[]
}
export interface LeadLike {
  id: string
  displayName: string
  primaryAddressSummary: string | null
  timezone: string | null
  priorityScore: number | null
  topMatchFit: number | null
  captureStatus: string | null
  matchReason: string | null
  dealflowDeepLink: string | null
}

// Primary Contact = lowest createdAt, ties broken by id asc.
export function pickPrimaryContact<T extends { id: string; createdAt: Date }>(
  contacts: T[]
): T | null {
  if (contacts.length === 0) return null
  return [...contacts].sort(
    (a, b) => a.createdAt.getTime() - b.createdAt.getTime() || (a.id < b.id ? -1 : 1)
  )[0]
}

// Primary phone = isPrimary=true first; else lowest createdAt, ties by id asc.
export function pickPrimaryPhone(phones: PhoneLike[]): PhoneLike | null {
  if (phones.length === 0) return null
  const flagged = phones.filter((p) => p.isPrimary)
  const pool = flagged.length > 0 ? flagged : phones
  return [...pool].sort(
    (a, b) => a.createdAt.getTime() - b.createdAt.getTime() || (a.id < b.id ? -1 : 1)
  )[0]
}

// Display timezone (UI hint): Contact ?? Lead ?? America/New_York.
export function displayTimezone(contactTz: string | null, leadTz: string | null): string {
  return contactTz ?? leadTz ?? DISPLAY_TZ_FALLBACK
}

// Compliance timezone: Contact ?? Lead, NEVER a fabricated fallback. Undefined
// means "omit from the compliance request" so C fail-closes it.
export function complianceTimezone(
  contactTz: string | null,
  leadTz: string | null
): string | undefined {
  return contactTz ?? leadTz ?? undefined
}

export interface QueueLead {
  leadId: string
  contactId: string
  primaryPhoneId: string
  primaryPhoneE164: string
  displayName: string
  primaryAddressSummary: string | null
  timezone: string
  ammunition: {
    priorityScore: number | null
    topMatchFit: number | null
    captureStatus: string | null
    matchReason: string | null
    dealflowDeepLink: string | null
  }
}

export interface QueueResponse {
  view: { id: string; name: string }
  leads: QueueLead[]
  excludedNoPhone: number
  excludedCompliance: number
  generatedAt: string
  stale: boolean
  staleReason?: string
}

export interface GetQueueOptions {
  limit?: number
  caller?: BatchCaller
  atInstant?: string
}

export async function loadCustomFieldTypes(organizationId: string): Promise<CompileContext['customFieldTypes']> {
  const defs = await prisma.customFieldDefinition.findMany({
    where: { organizationId },
    select: { id: true, type: true },
  })
  return Object.fromEntries(defs.map((d) => [d.id, d.type])) as CompileContext['customFieldTypes']
}

// ── The Queue's order (Brief 50 PR 10, open item 6.8) ──────────────────────
// DealFlow ranks its call list by an unrounded priority (87.4 above 87.2), but
// the CRM stores that priority as a whole number (sync.ts rounds it into an
// Int column), so sorting by it tied sellers DealFlow had told apart and broke
// the tie by "top match" and lead id instead. When a view is ordered by
// DealFlow's priority, leads with the same whole-number priority now go in
// DealFlow's own rank order (the signal's queueRank); the stored whole-number
// priority is still what's shown, and still the first key. DealFlow numbers
// its list by sorting on that same priority (best first), and rounding never
// swaps two numbers, so for every ranked lead this IS DealFlow's order.
//
// A lead's rank is its signal's, found the way the morning copy assigns
// signals to leads (dealflow-sync/write.ts MAPPED_LEADS): the lead DealFlow
// names (crmLeadId), else the lead with the signal's Mojo ID; the best rank if
// two reach one lead. Leads with no rank keep their place by priority: one an
// upload scored since the morning copy (a priority, but no place on DealFlow's
// list until tomorrow) sits where its score puts it, as on every list (Brief
// 45: new people are ranked within minutes), after any ranked lead with the
// same whole number; never-scored leads come last. Then the view's own order,
// then lead id: lead.id is always the last key, so the order is total: the
// same on every load, and pages neither repeat nor skip a lead.
//
// One read of the org's signals per query: an uncorrelated scalar subquery, so
// Postgres runs it once (an InitPlan) and each lead is a key lookup in the
// resulting {leadId: rank} object.
function dealflowRankSql(org: string): string {
  return `((SELECT jsonb_object_agg(r.lead_id, r.queue_rank) FROM (
      SELECT COALESCE(by_id.id, by_mojo.id) AS lead_id, min(s."queueRank") AS queue_rank
      FROM "DealFlowDerivedSignal" s
      LEFT JOIN "Lead" by_id ON by_id.id = s."dealflowRawJson"->>'crmLeadId' AND by_id."organizationId" = ${org}
      LEFT JOIN "Lead" by_mojo ON by_mojo."mojoId" = s."mojoId" AND by_mojo."organizationId" = ${org}
      WHERE s."organizationId" = ${org} AND s."queueRank" IS NOT NULL AND COALESCE(by_id.id, by_mojo.id) IS NOT NULL
      GROUP BY 1) r) ->> lead.id)::int`
}

/**
 * The ORDER BY for a view's leads on the Queue, and the query to run it with.
 * A view ordered first by DealFlow's priority (the "DealFlow priority" view,
 * or no saved sort: compileOrderBy's default) gets DealFlow's rank right after
 * the priority, in front of the rest of its sort; the rank's organization
 * travels as one extra bound parameter, so `compiled` comes back with it
 * appended (the caller's is left as it was). Any other sort is
 * compileOrderBy's, unchanged.
 */
export function queueOrder(
  compiled: CompiledQuery,
  sort: SortSpec,
  organizationId: string
): { compiled: CompiledQuery; orderBySql: string } {
  const orderBySql = compileOrderBy(sort)
  const first = sort[0] ?? { field: 'priorityScore', direction: 'desc' }
  if (first.field !== 'priorityScore') return { compiled, orderBySql }
  const asc = first.direction === 'asc'
  const priority = `ORDER BY lead."priorityScore" ${asc ? 'ASC' : 'DESC'} NULLS LAST, `
  if (!orderBySql.startsWith(priority)) throw new Error('queueOrder: unexpected ORDER BY from compileOrderBy')
  const org = `$${compiled.params.length + 1}`
  // Rank 1 is DealFlow's top seller: best first reads the rank upwards.
  const rank = `${dealflowRankSql(org)} ${asc ? 'DESC' : 'ASC'} NULLS LAST, `
  return {
    compiled: { ...compiled, params: [...compiled.params, organizationId] },
    orderBySql: priority + rank + orderBySql.slice(priority.length),
  }
}

export async function getQueue(
  viewId: string,
  organizationId: string,
  opts: GetQueueOptions = {}
): Promise<QueueResponse> {
  const limit = Math.min(opts.limit ?? 50, 200)

  const view = await prisma.savedView.findFirst({ where: { id: viewId, organizationId } })
  if (!view) throw new HttpError(404, 'SavedView not found')
  if (view.type !== 'lead') throw new HttpError(400, `SavedView type must be 'lead', got '${view.type}'`)

  const sQuery = sQuerySchema.parse(view.sQuery)
  const sort: SortSpec = sortSpecSchema.parse(view.sort ?? [])
  const customFieldTypes = await loadCustomFieldTypes(organizationId)
  const compiled = compile(sQuery, { organizationId, customFieldTypes })

  const ordered = queueOrder(compiled, sort, organizationId)
  const poolSize = Math.min(CANDIDATE_POOL_CAP, Math.max(limit * 5, 200))
  const candidates = await execute<LeadLike>(ordered.compiled, prisma, {
    organizationId,
    selectSql:
      'lead.id, lead."displayName", lead."primaryAddressSummary", lead."timezone", ' +
      'lead."priorityScore", lead."topMatchFit", lead."captureStatus", lead."matchReason", lead."dealflowDeepLink"',
    orderBySql: ordered.orderBySql,
    limit: poolSize,
  })

  const leadIds = candidates.map((c) => c.id)
  const contacts = leadIds.length
    ? await prisma.contact.findMany({
        where: { leadId: { in: leadIds } },
        select: {
          id: true,
          leadId: true,
          timezone: true,
          createdAt: true,
          phones: {
            select: { id: true, phone: true, phoneFormatted: true, isPrimary: true, createdAt: true },
          },
        },
      })
    : []
  const contactsByLead = new Map<string, ContactLike[]>()
  for (const c of contacts) {
    const arr = contactsByLead.get(c.leadId) ?? []
    arr.push(c)
    contactsByLead.set(c.leadId, arr)
  }

  // Resolve primacy; drop leads with no primary phone.
  interface Resolved {
    lead: LeadLike
    contactId: string
    phone: PhoneLike
    complianceTz?: string
    displayTz: string
  }
  const resolved: Resolved[] = []
  let excludedNoPhone = 0
  for (const lead of candidates) {
    const contact = pickPrimaryContact(contactsByLead.get(lead.id) ?? [])
    const phone = contact ? pickPrimaryPhone(contact.phones) : null
    if (!contact || !phone) {
      excludedNoPhone++
      continue
    }
    resolved.push({
      lead,
      contactId: contact.id,
      phone,
      complianceTz: complianceTimezone(contact.timezone, lead.timezone),
      displayTz: displayTimezone(contact.timezone, lead.timezone),
    })
  }

  // UNCONDITIONAL compliance scrub of every survivor.
  const entries: CallableEntry[] = resolved.map((r) => ({
    contactPhoneId: r.phone.id,
    phone: r.phone.phone,
    ...(r.complianceTz ? { timezone: r.complianceTz } : {}),
  }))
  const outcome = await checkCallable(entries, { caller: opts.caller, atInstant: opts.atInstant })

  let excludedCompliance = 0
  const leads: QueueLead[] = []
  for (const r of resolved) {
    const verdict = outcome.byPhoneId.get(r.phone.id)
    if (!verdict || !verdict.callable) {
      excludedCompliance++
      continue
    }
    if (leads.length >= limit) break
    leads.push({
      leadId: r.lead.id,
      contactId: r.contactId,
      primaryPhoneId: r.phone.id,
      primaryPhoneE164: r.phone.phone,
      displayName: r.lead.displayName,
      primaryAddressSummary: r.lead.primaryAddressSummary,
      timezone: r.displayTz,
      ammunition: {
        priorityScore: r.lead.priorityScore,
        topMatchFit: r.lead.topMatchFit,
        captureStatus: r.lead.captureStatus,
        matchReason: r.lead.matchReason,
        dealflowDeepLink: r.lead.dealflowDeepLink,
      },
    })
  }

  // Staleness: compliance connectivity failure OR DealFlow signals >24h old.
  let stale = false
  let staleReason: string | undefined
  if (outcome.connectivityFailure) {
    stale = true
    staleReason = 'Compliance service unavailable'
  } else {
    // The morning update's clock: rows an upload's scoring wrote don't count, so
    // an upload can't hide a morning sync that stopped (Brief 45 PR F)
    // [engineering precaution].
    const [latest] = await prisma.$queryRaw<{ rankedAt: Date | null }[]>`SELECT ${rankingTimesSql(organizationId)}`
    const syncedAt = latest?.rankedAt ?? null
    if (syncedAt) {
      const ageMs = Date.now() - syncedAt.getTime()
      if (ageMs > DEALFLOW_STALE_MS) {
        stale = true
        staleReason = `DealFlow signals last synced ${Math.round(ageMs / 3_600_000)}h ago`
      }
    }
  }

  return {
    view: { id: view.id, name: view.name },
    leads,
    excludedNoPhone,
    excludedCompliance,
    generatedAt: new Date().toISOString(),
    stale,
    ...(staleReason ? { staleReason } : {}),
  }
}
