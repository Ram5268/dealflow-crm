// Brief 45 (PR F): writes DealFlow's answer for one chunk of an upload's new
// leads (CONTRACT §7 step 4). Only those leads, and only their fields:
//   - priorityScore, topMatchFit, captureStatus, matchReason and the deep link,
//     computed exactly as the morning sync computes them from DealFlow's call
//     list (dealflow-sync/sync.ts buildSignals + write.ts UPDATE_LEADS_SQL),
//     and dealflowSignalSyncedAt for every lead DealFlow scored, also those
//     it found no buyer match for ("not ranked: no match");
//   - a signal row for each ranked lead (so its best buyer shows), marked as an
//     upload's (marker.ts) so the morning clocks don't move.
// This is an upsert of these rows only. The morning sync's whole-list
// statements, which clear the rank of everyone missing from DealFlow's list,
// are never used here: run for a few new people they would wipe everyone
// else's rank and signals [brief §5.8, the second trap]. Leads DealFlow
// skipped (no Mojo ID, not copied) are left exactly as they are.
import { randomUUID } from 'node:crypto'
import type { PrismaClient } from '@prisma/client'
import { toBuyers } from '@/lib/core-data/dealflow-sync/buyers'
import { dealflowDeepLink } from '@/lib/core-data/dealflow-sync/sync'
import { IMPORT_SCORING_SOURCE } from './marker'
import type { ScoreResponse, ScoredLead } from './request'

const round = (n: number | null) => (n === null ? null : Math.round(n))

export interface LeadFields {
  id: string
  mojoId: string
  priorityScore: number | null
  topMatchFit: number | null
  captureStatus: string | null
  matchReason: string | null
  dealflowDeepLink: string | null
}

/** The lead's five DealFlow fields, as the morning sync would write them for the same seller. */
export function leadFields(s: ScoredLead): LeadFields {
  return {
    id: s.crmLeadId,
    mojoId: s.mojoId,
    priorityScore: round(s.priorityScore),
    topMatchFit: round(s.primaryMatchFit),
    captureStatus: s.primaryCaptureStatus,
    matchReason: s.matchReason ?? s.queueReason ?? null,
    dealflowDeepLink: dealflowDeepLink(s.primaryMatchId),
  }
}

const isRanked = (s: ScoredLead) => s.notRankedReason === null && s.priorityScore !== null

export interface SignalRow {
  mojoId: string
  priorityScore: number | null
  queueReason: string | null
  primaryMatchId: string | null
  primaryMatchFit: number | null
  primaryCaptureStatus: string | null
  primaryMatchConfidence: string | null
  dealflowRawJson: Record<string, unknown>
}

/**
 * The signal row for a ranked seller, or null for one DealFlow left unranked
 * (the morning sync keeps no signal for a seller missing from its list). The
 * raw JSON has the morning row's fields (buyers whitelisted again, never a
 * phone or email [Brief 38]) and the flag the calling-off banner reads, but no
 * batch time or run id: it is marked as an upload's instead (marker.ts).
 */
export function signalRow(s: ScoredLead, response: ScoreResponse, importId: string): SignalRow | null {
  if (!isRanked(s)) return null
  return {
    mojoId: s.mojoId,
    priorityScore: round(s.priorityScore),
    queueReason: s.queueReason,
    primaryMatchId: s.primaryMatchId,
    primaryMatchFit: round(s.primaryMatchFit),
    primaryCaptureStatus: s.primaryCaptureStatus,
    primaryMatchConfidence: s.primaryMatchConfidence,
    dealflowRawJson: {
      source: IMPORT_SCORING_SOURCE,
      importId,
      importScoredAt: response.generatedAt,
      contactId: null,
      crmLeadId: s.crmLeadId,
      queueRank: null,
      priorityScore: s.priorityScore,
      queueReason: s.queueReason,
      primaryMatchId: s.primaryMatchId,
      primaryMatchFit: s.primaryMatchFit,
      primaryCaptureStatus: s.primaryCaptureStatus,
      primaryMatchConfidence: s.primaryMatchConfidence,
      matchReason: s.matchReason,
      contributions: s.contributions ?? null,
      buyers: toBuyers(s.buyers),
      includeTestBuyers: response.includeTestBuyers,
    },
  }
}

const LEAD_COLUMNS =
  'id text, "mojoId" text, "priorityScore" int, "topMatchFit" int, "captureStatus" text, "matchReason" text, "dealflowDeepLink" text'

// $1 = rows (jsonb), $2 = organizationId, $3 = when (ISO). By lead id, in the
// org, and only while the lead still has the Mojo ID DealFlow scored.
export const WRITE_SCORED_LEADS_SQL = `
  UPDATE "Lead" AS l SET "priorityScore" = s."priorityScore", "topMatchFit" = s."topMatchFit",
    "captureStatus" = s."captureStatus", "matchReason" = s."matchReason", "dealflowDeepLink" = s."dealflowDeepLink",
    "dealflowSignalSyncedAt" = ($3::timestamptz AT TIME ZONE 'UTC')
  FROM jsonb_to_recordset($1::jsonb) AS s(${LEAD_COLUMNS})
  WHERE l.id = s.id AND l."organizationId" = $2 AND l."mojoId" = s."mojoId"
  RETURNING l.id`

const SIGNAL_COLUMNS =
  'id text, "mojoId" text, "priorityScore" int, "queueReason" text, "primaryMatchId" text, "primaryMatchFit" int, ' +
  '"primaryCaptureStatus" text, "primaryMatchConfidence" text, "dealflowRawJson" jsonb'

// $1 = rows (jsonb), $2 = organizationId, $3 = when (ISO). Keyed by Mojo ID,
// like the morning sync's own upsert; a row of another organization is left
// alone. On an existing row the raw JSON is merged, not replaced: these keys
// win, and keys this scoring doesn't write (Brief 44's `property`, for one)
// stay [coordination with Brief 44 PR 5].
export const UPSERT_SCORED_SIGNALS_SQL = `
  INSERT INTO "DealFlowDerivedSignal" (id, "organizationId", "mojoId", "queueRank", "priorityScore", "queueReason",
    "primaryMatchId", "primaryMatchFit", "primaryCaptureStatus", "primaryMatchConfidence", "syncedAt", "dealflowRawJson")
  SELECT s.id, $2, s."mojoId", NULL, s."priorityScore", s."queueReason", s."primaryMatchId", s."primaryMatchFit",
    s."primaryCaptureStatus", s."primaryMatchConfidence", ($3::timestamptz AT TIME ZONE 'UTC'), s."dealflowRawJson"
  FROM jsonb_to_recordset($1::jsonb) AS s(${SIGNAL_COLUMNS})
  ON CONFLICT ("mojoId") DO UPDATE SET
    "queueRank" = NULL, "priorityScore" = EXCLUDED."priorityScore", "queueReason" = EXCLUDED."queueReason",
    "primaryMatchId" = EXCLUDED."primaryMatchId", "primaryMatchFit" = EXCLUDED."primaryMatchFit",
    "primaryCaptureStatus" = EXCLUDED."primaryCaptureStatus", "primaryMatchConfidence" = EXCLUDED."primaryMatchConfidence",
    "syncedAt" = EXCLUDED."syncedAt",
    "dealflowRawJson" = "DealFlowDerivedSignal"."dealflowRawJson" || EXCLUDED."dealflowRawJson"
  WHERE "DealFlowDerivedSignal"."organizationId" = EXCLUDED."organizationId"`

export interface WriteBackResult {
  /** The leads written (scored by DealFlow, in this chunk, still the same lead). */
  written: Set<string>
  /** Of those, how many DealFlow left unranked (no buyer match, or another hard filter). */
  notRanked: number
}

/**
 * Writes DealFlow's answer for the leads of `chunk` (ids the CRM sent), in one
 * transaction: all of it or none of it. Answers about any other lead are ignored.
 */
export async function writeBackScores(
  db: PrismaClient,
  organizationId: string,
  importId: string,
  response: ScoreResponse,
  chunk: ReadonlySet<string>,
  at: Date,
): Promise<WriteBackResult> {
  const byLead = new Map<string, ScoredLead>()
  for (const s of response.scored) if (chunk.has(s.crmLeadId) && !byLead.has(s.crmLeadId)) byLead.set(s.crmLeadId, s)
  const scored = [...byLead.values()]
  if (scored.length === 0) return { written: new Set(), notRanked: 0 }
  const when = at.toISOString()
  return db.$transaction(
    async (tx) => {
      const rows = await tx.$queryRawUnsafe<{ id: string }[]>(WRITE_SCORED_LEADS_SQL, JSON.stringify(scored.map(leadFields)), organizationId, when)
      const written = new Set(rows.map((r) => r.id))
      const signals = scored
        .filter((s) => written.has(s.crmLeadId))
        .map((s) => signalRow(s, response, importId))
        .filter((r): r is SignalRow => r !== null)
        .map((r) => ({ id: randomUUID(), ...r }))
      if (signals.length > 0) await tx.$executeRawUnsafe(UPSERT_SCORED_SIGNALS_SQL, JSON.stringify(signals), organizationId, when)
      return { written, notRanked: scored.filter((s) => written.has(s.crmLeadId) && !isRanked(s)).length }
    },
    { maxWait: 10_000, timeout: 60_000 },
  )
}
