import type { PrismaClient } from '@prisma/client'
import { prisma } from '@/lib/prisma'
import { logger } from '@/lib/logger'
import { toPropertyFacts, type DealflowProperty, MAX_VALUE_AGE_DAYS } from './property'
import { dealflowRoConfigured, roQuery } from './ro-client'
import { propertySql } from './sync'

// Brief 44 (PR 5): reads DealFlow's estimate stored on a lead's signal
// (dealflowRawJson.property). The signal is found the way getLeadBuyers finds
// it (buyer-lookup.ts): the lead DealFlow names (crmLeadId), else the lead with
// its mojoId. Whitelisted again on the way out, so the card only ever sees
// toPropertyFacts' fields. Null before any published run.
//
// Brief 50 (PR 12), open item 5.7: the morning copy stores values only for the
// sellers on DealFlow's call list, so a valued seller DealFlow leaves off the
// list (8 on Oct 19) had no card. When the lead has no stored value, the card
// now reads that one seller's newest published valuation from DealFlow itself:
// one read-only statement (roQuery), only DealFlow's organization with this
// CRM organization's slug (as the morning copy reads), the same PROPERTY
// fields (propertySql, with its 100-day rule) and the same whitelist.
// Nothing is written: the Queue and every list are unchanged. The value stays
// on this card, Ryan's own screen (Ryan's decision, 2026-10-17: our value
// estimates never reach anything a buyer or homeowner sees).

// The longest the lead page waits for DealFlow (as the Queue's last-night
// notice, nightly-notice.ts): past it there is simply no card, and the read
// left behind ends on its own. Brief 50 (PR 21): this is also the statement
// time limit asked of the database for that one read (roQuery's
// statementTimeoutMs, below), so the query itself stops on DealFlow's server
// around the same time, instead of running up to the shared pool's own 60 s
// default (ro-client.ts) and holding one of its 4 connections meanwhile
// [engineering precaution].
export const PROPERTY_LOOKUP_WAIT_MS = 2_500

// $1 = the CRM organization's slug, $2 = the CRM lead id, $3 = its Mojo ID.
// The seller DealFlow keeps under this lead id first, then by Mojo ID (a
// Mojo ID is unique in DealFlow). No phone, name or tax lot is selected.
export const LEAD_PROPERTY_SQL = `
  SELECT c."metadata"->>'crmLeadId' AS crm_lead_id, c."mojoId" AS mojo_id, ${propertySql('c."id"')} AS property
  FROM "MojoContact" c
  JOIN "Organization" o ON o."id" = c."organizationId"
  WHERE o."slug" = $1 AND (c."metadata"->>'crmLeadId' = $2 OR c."mojoId" = $3::text)
  ORDER BY (c."metadata"->>'crmLeadId' = $2) DESC NULLS LAST, c."id"
  LIMIT 5
`

type LeadKey = { id: string; mojoId: string | null }
type SellerRow = { crm_lead_id: string | null; mojo_id: string | null; property: unknown }

const DAY_MS = 86_400_000

// Brief 50 (PR 21), engineering precaution: the same 100-day rule the morning
// copy's own read applies (sync.ts propertySql, MAX_VALUE_AGE_DAYS), applied
// again here because a *stored* value can outlive it. The copy only refreshes
// this signal for a seller on DealFlow's call list; once PR 12's fallback was
// added, a seller who later drops off the list keeps whatever was last
// stored, forever, with nothing to re-check its age. A stale stored value is
// treated as if nothing were stored, so the live fallback below -- which asks
// DealFlow fresh, and applies the same rule in its own SQL -- gets a chance
// instead. No publishedAt (shouldn't happen for a real stored value) counts
// as stale, the same way the copy's SQL `>=` comparison excludes a NULL.
function isFresh(p: DealflowProperty, now = Date.now()): boolean {
  if (!p.publishedAt) return false
  const publishedAt = Date.parse(p.publishedAt)
  return Number.isFinite(publishedAt) && now - publishedAt <= MAX_VALUE_AGE_DAYS * DAY_MS
}

export async function getLeadProperty(
  organizationId: string,
  lead: LeadKey,
  db: PrismaClient = prisma,
  waitMs = PROPERTY_LOOKUP_WAIT_MS
): Promise<DealflowProperty | null> {
  const rows = await db.$queryRaw<{ property: unknown }[]>`
    SELECT s."dealflowRawJson"->'property' AS property FROM "DealFlowDerivedSignal" s
    WHERE s."organizationId" = ${organizationId}
      AND (s."dealflowRawJson"->>'crmLeadId' = ${lead.id}
        OR (s."mojoId" = ${lead.mojoId} AND NOT EXISTS (SELECT 1 FROM "Lead" o
          WHERE o.id = s."dealflowRawJson"->>'crmLeadId' AND o."organizationId" = ${organizationId})))
    ORDER BY s."queueRank" NULLS LAST
    LIMIT 1`
  const stored = toPropertyFacts(rows[0]?.property)
  if (stored && isFresh(stored)) return stored
  return toPropertyFacts(await readDealflowProperty(organizationId, lead, db, waitMs))
}

// The seller's raw valuation from DealFlow, or null. Never throws: with no
// read-only setting, in stub mode, without the organization, when the read
// fails or takes longer than waitMs, there is no card and the page is
// unaffected. The log line carries an error code only: no address, no SQL,
// no values.
async function readDealflowProperty(organizationId: string, lead: LeadKey, db: PrismaClient, waitMs: number): Promise<unknown> {
  if (process.env.DEALFLOW_SYNC_STUB === '1' || !dealflowRoConfigured()) return null
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    const org = await db.organization.findUnique({ where: { id: organizationId }, select: { slug: true } })
    if (!org) return null
    // Brief 50 (PR 21), engineering precaution: the database itself gives up
    // on this one read after the same length the page already waits
    // (waitMs), so a slow lookup can't go on holding one of the shared
    // read-only pool's 4 connections (ro-client.ts) that the 7 am copy needs
    // -- unlike the page's own wait below, which only stops the CRM from
    // waiting on the answer, not the query running on DealFlow's server. The
    // pool's 60 s default (DEALFLOW_STATEMENT_TIMEOUT_MS) is unchanged for
    // every other caller (the morning copy's own heavier reads).
    const read = roQuery<SellerRow>(LEAD_PROPERTY_SQL, [org.slug, lead.id, lead.mojoId], { statementTimeoutMs: waitMs })
    // An abandoned read still ends on its own; a failure after the wait is ignored, never thrown.
    read.catch(() => undefined)
    const timedOut = new Promise<'timeout'>((resolve) => {
      timer = setTimeout(() => resolve('timeout'), waitMs)
    })
    const outcome = await Promise.race([read, timedOut])
    if (outcome === 'timeout') {
      logger.warn({ code: 'timeout' }, "Lead page: DealFlow's value for this lead took too long to read, so no value card")
      return null
    }
    // As the stored signal is matched: the seller DealFlow keeps under this
    // lead, else the one with its Mojo ID unless DealFlow gave that seller to
    // another lead of this organization.
    const named = outcome.find((r) => r.crm_lead_id === lead.id)
    if (named) return named.property
    const byMojo = lead.mojoId ? outcome.find((r) => r.mojo_id === lead.mojoId) : undefined
    if (!byMojo) return null
    if (byMojo.crm_lead_id && (await db.lead.count({ where: { id: byMojo.crm_lead_id, organizationId } })) > 0) return null
    return byMojo.property
  } catch (err) {
    const code = (err as { code?: unknown } | null)?.code
    logger.warn({ code: typeof code === 'string' ? code : null }, "Lead page: couldn't read DealFlow's value for this lead, so no value card")
    return null
  } finally {
    clearTimeout(timer)
  }
}
