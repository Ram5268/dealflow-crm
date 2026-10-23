import { roQuery } from './ro-client'
import { toBuyers } from './buyers'
import { MAX_VALUE_AGE_DAYS, toPropertyFacts } from './property'
import { logger } from '@/lib/logger'

// ─────────────────────────────────────────────────────────────────────────────
// DealFlow signal sync — reads the latest nightly CallQueueEntry batch from
// DealFlow's `railway` DB (READ-ONLY) and projects it into DealFlowDerivedSignal
// upsert rows keyed by mojoId.
//
// NOTE (verified against the live DealFlow DB 2026-08-27): the real column names
// differ from the brief's reference block. Actual schema:
//   CallQueueEntry(id, organizationId, contactId, rank, priorityScore, reason,
//                  primaryMatchId, contributingMatchIds, contributions,
//                  generationRunId, generatedAt)
//   MojoContact(id, mojoId, fullName, phone, metadata, ...)  -- join id = contactId
//   Match(id, ..., score, captureStatus, matchFitConfidence, reason)
// So: queueRank=rank, queueReason=reason, mojoId via MojoContact,
//     primaryMatchFit=Match.score. This mapping is A-side (my owned table); the
//     DealFlow schema is a read reference, not a frozen cross-agent contract.
//
// Brief 37: the WHOLE latest batch (DealFlow now persists every ranked CRM
// seller, ~1,478), in rank order, with the CRM Lead id DealFlow keeps in
// MojoContact.metadata.crmLeadId, plus the run's includeTestBuyers flag.
// Brief 38: plus each seller's matched buyers (up to 5), kept in dealflowRawJson.
// Brief 44: plus DealFlow's newest published estimate of each seller's home
// (PROPERTY_SQL), whitelisted by toPropertyFacts into dealflowRawJson.property.
// ─────────────────────────────────────────────────────────────────────────────

// Shape of a joined RO row (snake-cased aliases from the SELECT below).
export interface DealflowJoinRow {
  mojo_id: string | null
  crm_lead_id: string | null
  queue_rank: number | null
  priority_score: number | null
  queue_reason: string | null
  primary_match_id: string | null
  primary_match_fit: number | null
  primary_capture_status: string | null
  primary_match_confidence: string | null
  match_reason: string | null
  contactId: string | null
  contributions: unknown
  generation_run_id: string | null
  generated_at: Date | string | null
  buyers?: unknown // Brief 38: the seller's matched buyers (BUYERS_SQL), whitelisted by toBuyers
  property?: unknown // Brief 44: the seller's newest published valuation (PROPERTY_SQL), whitelisted by toPropertyFacts
}

export interface DealflowBatch {
  rows: DealflowJoinRow[]
  includeTestBuyers: boolean | null // DealFlow's latest NIGHTLY_SCORING; null if unknown
}

export interface DerivedSignalUpsert {
  mojoId: string
  crmLeadId: string | null
  queueRank: number | null
  priorityScore: number | null
  queueReason: string | null
  primaryMatchId: string | null
  primaryMatchFit: number | null
  primaryCaptureStatus: string | null
  primaryMatchConfidence: string | null
  dealflowRawJson: Record<string, unknown>
  // Promotion-only fields (Lead ammunition), carried alongside for write.ts.
  matchReason: string | null
  dealflowDeepLink: string | null
}

const DEALFLOW_APP_BASE =
  process.env.DEALFLOW_APP_BASE_URL ?? 'https://dealflow-inbox-intelligence.vercel.app'

// Brief 37: the seller's top match on DealFlow's /matches page. No match → no
// link (the old /opportunities/<MojoContact id> link crashed in DealFlow).
export function dealflowDeepLink(primaryMatchId: string | null): string | null {
  return primaryMatchId ? `${DEALFLOW_APP_BASE}/matches?m=${encodeURIComponent(primaryMatchId)}` : null
}

// Pure transform: joined rows → derived-signal upsert payloads. Rows without a
// mojoId are dropped (nothing to join to a CRM Lead). Never fabricates data.
export function buildSignals(batch: DealflowBatch): DerivedSignalUpsert[] {
  const out: DerivedSignalUpsert[] = []
  for (const r of batch.rows) {
    if (!r.mojo_id) continue
    const roundOrNull = (n: number | null) =>
      n === null || n === undefined ? null : Math.round(n)
    out.push({
      mojoId: r.mojo_id,
      crmLeadId: r.crm_lead_id ?? null,
      queueRank: roundOrNull(r.queue_rank),
      priorityScore: roundOrNull(r.priority_score),
      queueReason: r.queue_reason ?? null,
      primaryMatchId: r.primary_match_id ?? null,
      primaryMatchFit: roundOrNull(r.primary_match_fit),
      primaryCaptureStatus: r.primary_capture_status ?? null,
      primaryMatchConfidence: r.primary_match_confidence ?? null,
      matchReason: r.match_reason ?? r.queue_reason ?? null,
      dealflowDeepLink: dealflowDeepLink(r.primary_match_id ?? null),
      dealflowRawJson: {
        contactId: r.contactId,
        crmLeadId: r.crm_lead_id ?? null,
        queueRank: r.queue_rank,
        priorityScore: r.priority_score,
        queueReason: r.queue_reason,
        primaryMatchId: r.primary_match_id,
        primaryMatchFit: r.primary_match_fit,
        primaryCaptureStatus: r.primary_capture_status,
        primaryMatchConfidence: r.primary_match_confidence,
        matchReason: r.match_reason,
        contributions: r.contributions ?? null,
        buyers: toBuyers(r.buyers),
        property: toPropertyFacts(r.property),
        // Run-level facts, stored with every signal of the run (no run table).
        generationRunId: r.generation_run_id ?? null,
        generatedAt: r.generated_at instanceof Date ? r.generated_at.toISOString() : r.generated_at,
        includeTestBuyers: batch.includeTestBuyers,
      },
    })
  }
  return out
}

// Freshness guard: DealFlow's run lands 09:00-09:59 UTC and this sync runs at
// 11:00 UTC. An empty batch, or one older than 36h (DealFlow missed a night),
// writes nothing — so a broken run can never blank every lead.
export const MAX_BATCH_AGE_MS = 36 * 60 * 60 * 1000

export type Freshness =
  | { ok: true; generatedAt: Date }
  | { ok: false; reason: 'empty' | 'stale'; generatedAt: Date | null }

export function checkFreshness(rows: DealflowJoinRow[], now: Date = new Date()): Freshness {
  const first = rows.find((r) => r.mojo_id)
  if (!first) return { ok: false, reason: 'empty', generatedAt: null }
  const at = first.generated_at == null ? null : new Date(first.generated_at)
  if (!at || Number.isNaN(at.getTime()) || now.getTime() - at.getTime() > MAX_BATCH_AGE_MS) {
    return { ok: false, reason: 'stale', generatedAt: at && !Number.isNaN(at.getTime()) ? at : null }
  }
  return { ok: true, generatedAt: at }
}

// Brief 38: each seller's matched buyers — its entry's primary + contributing
// matches (max 5, best first) — with the buyer's facts read the way DealFlow's
// matcher reads them (adapters.ts opportunityToBuyerData / mojoContactToBuyerData:
// neighborhoods fall back to the single neighborhood, ranges to the point value,
// cashOnly means a cash buyer). Selects no phone number or email of any kind.
export const BUYERS_SQL = `(
    SELECT COALESCE(jsonb_agg(to_jsonb(b) - 'ord' ORDER BY b."score" DESC, b.ord), '[]'::jsonb) FROM (
      SELECT x.ord, m."id" AS "matchId", m."score", m."tier", string_to_array(m."reason", ' + ') AS "reasonKeys",
        m."captureStatus", m."counterpartType" AS "type",
        COALESCE(eo."sourceAgentName", bc."fullName") AS "name", eo."sourceBrokerage" AS "brokerage",
        CASE WHEN cardinality(eo."neighborhoods") > 0 THEN eo."neighborhoods" ELSE array_remove(ARRAY[COALESCE(
          NULLIF(eo."neighborhood", ''), NULLIF(bc."neighborhood", ''), NULLIF(bc."initialNeighborhood", ''))], NULL) END AS "neighborhoods",
        COALESCE(eo."propertyTypes", '{}') AS "propertyTypes",
        COALESCE(eo."minBeds", eo."beds", bc."bedsMin") AS "bedsMin",
        COALESCE(eo."maxBeds", eo."beds", bc."bedsMax") AS "bedsMax",
        COALESCE(eo."minPrice", eo."price", bc."budgetMin") AS "priceMin",
        COALESCE(eo."maxPrice", eo."price", bc."budgetMax") AS "priceMax",
        COALESCE(eo."buyerArchetype", CASE WHEN bc."cashOnly" THEN 'CASH_BUYER' END) AS "buyerArchetype",
        COALESCE(eo."isTestData", bc."isTestData", false) AS "isTestData"
      FROM unnest(array_prepend(cqe."primaryMatchId", cqe."contributingMatchIds")) WITH ORDINALITY AS x(id, ord)
      JOIN "Match" m ON m."id" = x.id
      LEFT JOIN "ExtractedOpportunity" eo ON m."counterpartType" = 'opportunity' AND eo."id" = m."counterpartId"
      LEFT JOIN "MojoContact" bc ON m."counterpartType" = 'mojo' AND bc."id" = m."counterpartId"
      ORDER BY x.ord LIMIT 5
    ) b)`

// Brief 44 (PR 5): DealFlow's own estimate of the seller's home, for Ryan's lead
// page only (our value estimates stay out of anything a buyer or homeowner
// could see: Ryan's decision, 2026-10-17). The entry's contact's newest
// valuation from a PUBLISHED run, i.e. one that passed the job's publish checks
// (engineering precaution, Brief 44 §5); "newest" = publishedAt DESC NULLS LAST,
// as everywhere in Brief 44. One jsonb object with the run's dates and data
// sources, or NULL before any published run. publishedAt (stored as UTC with no
// zone) is written as UTC ISO. Selects no tax lot number and nothing about a
// person (engineering precaution: data minimization).
// Brief 50 (PR 12): one builder for any contact (the call list's here, one
// lead's on the lead page: property-lookup.ts). A run published more than
// MAX_VALUE_AGE_DAYS ago is ignored, as DealFlow's matching ignores it (Brief
// 49 PR 3); filtering before "newest" gives the same answer as dropping an old
// newest one, since every other run is older still. Measured by DealFlow's
// clock in UTC (publishedAt has no zone), whatever the session's time zone.
export function propertySql(contactId: string): string {
  return `(
    SELECT jsonb_build_object(
      'asOf', pv."asOf", 'dataThrough', vr."dataThrough",
      'publishedAt', to_char(vr."publishedAt", 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
      'value', pv."value", 'low', pv."low", 'high', pv."high", 'reason', pv."reason",
      'facts', pv."factsJson", 'comps', pv."compsJson", 'sources', vr."sourcesJson")
    FROM "PropertyValuation" pv
    JOIN "ValuationRun" vr ON vr."id" = pv."runId"
    WHERE pv."contactId" = ${contactId} AND vr."published" = true
      AND vr."publishedAt" >= (now() AT TIME ZONE 'UTC') - interval '${MAX_VALUE_AGE_DAYS} days'
    ORDER BY vr."publishedAt" DESC NULLS LAST
    LIMIT 1)`
}
export const PROPERTY_SQL = propertySql('cqe."contactId"')

// Brief 37: the whole latest batch (the run owning the newest generatedAt), in
// rank order, no cap.
// Brief 50 (PR 11), engineering precaution (open item 6.10): only from the
// DealFlow organization whose slug is the CRM organization's ($1). Both apps
// name Ryan's organization "dealflow-ryan", and DealFlow's own copy of the
// CRM's leads (lib/crm-sync/runSync.ts, ORG_SLUG) pairs them the same way; the
// two apps' organization ids differ. An organization DealFlow doesn't have
// reads no rows, and the copy skips as "empty".
export const RO_SQL = `
  WITH latest AS (
    SELECT q."organizationId", q."generationRunId" FROM "CallQueueEntry" q
    JOIN "Organization" o ON o."id" = q."organizationId"
    WHERE o."slug" = $1
    ORDER BY q."generatedAt" DESC LIMIT 1
  )
  SELECT
    mc."mojoId"              AS mojo_id,
    mc."metadata"->>'crmLeadId' AS crm_lead_id,
    cqe."rank"              AS queue_rank,
    cqe."priorityScore"     AS priority_score,
    cqe."reason"           AS queue_reason,
    cqe."primaryMatchId"    AS primary_match_id,
    cqe."contactId"         AS "contactId",
    cqe."contributions"     AS contributions,
    cqe."generationRunId"   AS generation_run_id,
    cqe."generatedAt" AT TIME ZONE 'UTC' AS generated_at, -- column is UTC without tz; keep it UTC whatever the process TZ
    m."score"              AS primary_match_fit,
    m."captureStatus"       AS primary_capture_status,
    m."matchFitConfidence"  AS primary_match_confidence,
    m."reason"             AS match_reason,
    ${BUYERS_SQL} AS buyers,
    ${PROPERTY_SQL} AS property
  FROM latest
  JOIN "CallQueueEntry" cqe ON cqe."organizationId" = latest."organizationId"
    AND cqe."generationRunId" = latest."generationRunId"
  JOIN "MojoContact" mc ON mc."id" = cqe."contactId" AND mc."organizationId" = cqe."organizationId"
  LEFT JOIN "Match" m   ON m."id" = cqe."primaryMatchId"
  ORDER BY cqe."rank"
`

// Whether DealFlow's latest scoring run used test buyers (drives the banner).
// Brief 50 (PR 11): that organization's own run ($1 = slug, as RO_SQL).
export const RUN_INFO_SQL = `
  SELECT (a."detailsJson"->>'includeTestBuyers')::boolean AS include_test_buyers
  FROM "AuditLog" a JOIN "Organization" o ON o."id" = a."organizationId"
  WHERE o."slug" = $1 AND a."action" = 'NIGHTLY_SCORING' ORDER BY a."createdAt" DESC LIMIT 1
`

// Brief 44: whether DealFlow's valuation tables exist yet (data step V1).
// Postgres looks up every table a statement names before it runs any of it, so
// no guard inside RO_SQL can skip PROPERTY_SQL: this separate one-statement read
// picks which RO_SQL to send. Before V1 (or if the tables are ever dropped) the
// sync still writes ranks and buyers, with property NULL, instead of failing
// whole (engineering precaution).
export const VALUATIONS_READY_SQL = `
  SELECT to_regclass('"PropertyValuation"') IS NOT NULL AND to_regclass('"ValuationRun"') IS NOT NULL AS ready
`
export const RO_SQL_WITHOUT_PROPERTY = RO_SQL.replace(PROPERTY_SQL, 'NULL::jsonb')

// Fetches the latest queue batch of the DealFlow organization with this slug
// (the CRM organization's; Brief 50 PR 11) from DealFlow (read-only). In stub
// mode returns a small golden fixture without touching any DB (unit-scope shortcut).
export async function fetchDealflowBatch(orgSlug: string, now: Date = new Date()): Promise<DealflowBatch> {
  if (process.env.DEALFLOW_SYNC_STUB === '1') {
    return stubBatch(now)
  }
  const [ready, info] = await Promise.all([
    roQuery<{ ready: boolean | null }>(VALUATIONS_READY_SQL),
    roQuery<{ include_test_buyers: boolean | null }>(RUN_INFO_SQL, [orgSlug]),
  ])
  const valuationsReady = ready[0]?.ready === true
  if (!valuationsReady) logger.warn('DealFlow sync: the valuation tables are not there yet, so no property card data this run')
  const rows = await roQuery<DealflowJoinRow>(valuationsReady ? RO_SQL : RO_SQL_WITHOUT_PROPERTY, [orgSlug])
  return { rows, includeTestBuyers: info[0]?.include_test_buyers ?? null }
}

// Stamped with `now` so stub runs pass the freshness guard.
export function stubBatch(now: Date = new Date()): DealflowBatch {
  return { includeTestBuyers: true, rows: STUB_ROWS.map((r) => ({ ...r, generated_at: now.toISOString() })) }
}

export const STUB_ROWS: DealflowJoinRow[] = [
  {
    mojo_id: 'mojo_stub_1',
    crm_lead_id: null,
    queue_rank: 1,
    priority_score: 93,
    queue_reason: 'Top 94-scored match',
    primary_match_id: 'match_stub_1',
    primary_match_fit: 94,
    primary_capture_status: 'OWN_BUYER_ONLY',
    primary_match_confidence: 'high',
    match_reason: 'Strong buyer fit in West Village',
    contactId: 'contact_stub_1',
    contributions: { matchFitLift: 32 },
    generation_run_id: 'run_stub_1',
    generated_at: '2026-08-24T06:14:36.587Z',
    buyers: [{ matchId: 'match_stub_1', score: 94, tier: 'HOT', reasonKeys: ['neighborhood', 'beds'], captureStatus: 'OWN_BUYER_ONLY',
      type: 'opportunity', name: 'Stub Agent', brokerage: null, neighborhoods: ['West Village'], propertyTypes: ['Condo'],
      bedsMin: 2, bedsMax: 3, priceMin: 1500000, priceMax: 2500000, buyerArchetype: 'CASH_BUYER', isTestData: true }],
    // Brief 44: an invented home and invented sales, so stub mode shows the property card.
    property: {
      asOf: '2026-10-01', dataThrough: '2026-09-30', publishedAt: '2026-10-20T10:31:00.000Z',
      value: 1830000, low: 1540000, high: 2120000, reason: null,
      facts: { units: 2, buildingSqft: 2400, lotSqft: 2000, yearBuilt: 1910, floors: 3, zoning: 'R6B', buildingClass: 'B1',
        historicDistrict: false, lastSale: { date: '2015-06-03', price: 1200000 }, dofMarketValue: { value: 1410000, fiscalYear: 2027 },
        permits7y: { count: 2, major: true }, openViolations: { dob: 0, ecb: 1, hpd: 0 }, subwayMiles: 0.3,
        leadVsCity: { units: { lead: 3, city: 2 }, buildingSqft: null } },
      comps: [
        { address: '12 Example St', date: '2026-09-12', price: 1750000, pricePerSqft: 712, distanceMiles: 0.1 },
        { address: '40 Example Ave', date: '2026-08-28', price: 1690000, pricePerSqft: 655, distanceMiles: 0.3 },
      ],
      sources: { downloadedOn: '2026-10-18', salesThrough: '2026-09-30', plutoVersion: '26v2', rollFiscalYear: 2027, datasets: {} },
    },
  },
]
