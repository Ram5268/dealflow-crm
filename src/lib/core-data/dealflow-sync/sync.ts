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
//   MojoContact(id, mojoId, fullName, phone, ...)          -- join id = contactId
//   Match(id, ..., score, captureStatus, matchFitConfidence, reason)
// So: queueRank=rank, queueReason=reason, mojoId via MojoContact,
//     primaryMatchFit=Match.score. This mapping is A-side (my owned table); the
//     DealFlow schema is a read reference, not a frozen cross-agent contract.
// ─────────────────────────────────────────────────────────────────────────────

// Shape of a joined RO row (snake-cased aliases from the SELECT below).
export interface DealflowJoinRow {
  mojo_id: string | null
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
  generated_at: Date | string | null
}

export interface DerivedSignalUpsert {
  mojoId: string
  queueRank: number | null
  priorityScore: number | null
  queueReason: string | null
  primaryMatchId: string | null
  primaryMatchFit: number | null
  primaryCaptureStatus: string | null
  primaryMatchConfidence: string | null
  dealflowRawJson: Record<string, unknown>
  // Promotion-only fields (Lead ammunition), carried alongside for promote.ts.
  matchReason: string | null
  dealflowDeepLink: string
}

const DEALFLOW_APP_BASE =
  process.env.DEALFLOW_APP_BASE_URL ?? 'https://dealflow-inbox-intelligence.vercel.app'

export function dealflowDeepLink(mojoContactId: string | null, mojoId: string): string {
  const target = mojoContactId ?? mojoId
  return `${DEALFLOW_APP_BASE}/opportunities/${target}`
}

// Pure transform: joined rows → derived-signal upsert payloads. Rows without a
// mojoId are dropped (nothing to join to a CRM Lead). Never fabricates data.
export function buildSignals(rows: DealflowJoinRow[]): DerivedSignalUpsert[] {
  const out: DerivedSignalUpsert[] = []
  for (const r of rows) {
    if (!r.mojo_id) continue
    const roundOrNull = (n: number | null) =>
      n === null || n === undefined ? null : Math.round(n)
    out.push({
      mojoId: r.mojo_id,
      queueRank: roundOrNull(r.queue_rank),
      priorityScore: roundOrNull(r.priority_score),
      queueReason: r.queue_reason ?? null,
      primaryMatchId: r.primary_match_id ?? null,
      primaryMatchFit: roundOrNull(r.primary_match_fit),
      primaryCaptureStatus: r.primary_capture_status ?? null,
      primaryMatchConfidence: r.primary_match_confidence ?? null,
      matchReason: r.match_reason ?? r.queue_reason ?? null,
      dealflowDeepLink: dealflowDeepLink(r.contactId, r.mojo_id),
      dealflowRawJson: {
        contactId: r.contactId,
        queueRank: r.queue_rank,
        priorityScore: r.priority_score,
        queueReason: r.queue_reason,
        primaryMatchId: r.primary_match_id,
        primaryMatchFit: r.primary_match_fit,
        primaryCaptureStatus: r.primary_capture_status,
        primaryMatchConfidence: r.primary_match_confidence,
        matchReason: r.match_reason,
        contributions: r.contributions ?? null,
        generatedAt: r.generated_at instanceof Date ? r.generated_at.toISOString() : r.generated_at,
      },
    })
  }
  return out
}

const RO_SQL = `
  SELECT
    mc."mojoId"              AS mojo_id,
    cqe."rank"              AS queue_rank,
    cqe."priorityScore"     AS priority_score,
    cqe."reason"           AS queue_reason,
    cqe."primaryMatchId"    AS primary_match_id,
    cqe."contactId"         AS "contactId",
    cqe."contributions"     AS contributions,
    cqe."generatedAt"       AS generated_at,
    m."score"              AS primary_match_fit,
    m."captureStatus"       AS primary_capture_status,
    m."matchFitConfidence"  AS primary_match_confidence,
    m."reason"             AS match_reason
  FROM "CallQueueEntry" cqe
  JOIN "MojoContact" mc ON mc."id" = cqe."contactId"
  LEFT JOIN "Match" m   ON m."id" = cqe."primaryMatchId"
  WHERE cqe."generatedAt" = (SELECT MAX("generatedAt") FROM "CallQueueEntry")
  LIMIT 500
`

// Fetches the latest queue batch from DealFlow (read-only). In stub mode returns
// a small golden fixture without touching any DB (unit-scope shortcut).
export async function fetchDealflowRows(): Promise<DealflowJoinRow[]> {
  if (process.env.DEALFLOW_SYNC_STUB === '1') {
    return STUB_ROWS
  }
  return roQuery<DealflowJoinRow>(RO_SQL)
}

export const STUB_ROWS: DealflowJoinRow[] = [
  {
    mojo_id: 'mojo_stub_1',
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
    generated_at: '2026-08-24T06:14:36.587Z',
  },
]
