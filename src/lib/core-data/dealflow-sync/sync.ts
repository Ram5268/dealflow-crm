import { roQuery } from './ro-client'

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

// Brief 37: the whole latest batch (the run owning the newest generatedAt), in
// rank order, no cap.
export const RO_SQL = `
  WITH latest AS (
    SELECT "generationRunId" FROM "CallQueueEntry" ORDER BY "generatedAt" DESC LIMIT 1
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
    m."reason"             AS match_reason
  FROM latest
  JOIN "CallQueueEntry" cqe ON cqe."generationRunId" = latest."generationRunId"
  JOIN "MojoContact" mc ON mc."id" = cqe."contactId"
  LEFT JOIN "Match" m   ON m."id" = cqe."primaryMatchId"
  ORDER BY cqe."rank"
`

// Whether DealFlow's latest scoring run used test buyers (drives the banner).
export const RUN_INFO_SQL = `
  SELECT ("detailsJson"->>'includeTestBuyers')::boolean AS include_test_buyers
  FROM "AuditLog" WHERE "action" = 'NIGHTLY_SCORING' ORDER BY "createdAt" DESC LIMIT 1
`

// Fetches the latest queue batch from DealFlow (read-only). In stub mode returns
// a small golden fixture without touching any DB (unit-scope shortcut).
export async function fetchDealflowBatch(now: Date = new Date()): Promise<DealflowBatch> {
  if (process.env.DEALFLOW_SYNC_STUB === '1') {
    return stubBatch(now)
  }
  const [rows, info] = await Promise.all([
    roQuery<DealflowJoinRow>(RO_SQL),
    roQuery<{ include_test_buyers: boolean | null }>(RUN_INFO_SQL),
  ])
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
  },
]
