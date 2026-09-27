import { prisma } from '@/lib/prisma'
import { HttpError } from '@/lib/shared/http'
import { compile, compileOrderBy, type CompileContext } from '@/lib/core-data/query-dsl/compiler'
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

  const orderBySql = compileOrderBy(sort)
  const poolSize = Math.min(CANDIDATE_POOL_CAP, Math.max(limit * 5, 200))
  const candidates = await execute<LeadLike>(compiled, prisma, {
    organizationId,
    selectSql:
      'lead.id, lead."displayName", lead."primaryAddressSummary", lead."timezone", ' +
      'lead."priorityScore", lead."topMatchFit", lead."captureStatus", lead."matchReason", lead."dealflowDeepLink"',
    orderBySql,
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
    const latest = await prisma.dealFlowDerivedSignal.aggregate({
      where: { organizationId },
      _max: { syncedAt: true },
    })
    const syncedAt = latest._max.syncedAt
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
