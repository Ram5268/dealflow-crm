import type { PrismaClient } from "@prisma/client";

/**
 * Server-side ammunition-panel hydration. SELECT-only across Agent A tables
 * (Lead, Contact, ContactPhone, DealFlowDerivedSignal) — reads are allowed;
 * Agent B never writes them. Shape per brief §8.1.
 *
 * Latency: ONE round trip (see the query note below). The guard in
 * tests/ammunition.latency.test.ts asserts hydrate's MARGINAL cost -- elapsed
 * minus a same-connection `SELECT 1` -- stays under 50ms, so an added round
 * trip fails the build wherever the DB lives. Absolute wall-clock is NOT
 * asserted: it is dominated by client->DB RTT (~91ms from a dev laptop across
 * Railway's public proxy), so it is logged, not gated. See docs/known-drift.md
 * "Test topology assumptions".
 */
export interface AmmoPhone {
  id: string;
  phone: string;
  phoneFormatted: string | null;
  type: string;
  lineType: string | null;
}

export interface AmmunitionPayload {
  lead: {
    id: string;
    displayName: string;
    priorityScore: number | null;
    topMatchFit: number | null;
    captureStatus: string | null;
    matchReason: string | null;
    dealflowDeepLink: string | null;
    primaryAddressSummary: string | null;
  } | null;
  contact: {
    id: string;
    displayName: string;
    phones: AmmoPhone[];
  } | null;
  derivedSignal: {
    queueRank: number | null;
    queueReason: string | null;
    primaryMatchFit: number | null;
    primaryCaptureStatus: string | null;
    primaryMatchConfidence: string | null;
  } | null;
}

interface AmmoRow {
  lead_id: string | null;
  lead_name: string | null;
  priority_score: number | null;
  top_match_fit: number | null;
  capture_status: string | null;
  match_reason: string | null;
  deep_link: string | null;
  address_summary: string | null;
  contact_id: string | null;
  contact_name: string | null;
  phones: AmmoPhone[] | null;
  signal_id: string | null;
  queue_rank: number | null;
  queue_reason: string | null;
  primary_match_fit: number | null;
  primary_capture_status: string | null;
  primary_match_confidence: string | null;
}

/**
 * Single-round-trip hydration. One LEFT-JOIN query across Call → Lead → Contact
 * → DealFlowDerivedSignal, with phones aggregated as JSON, keeps the endpoint
 * to a single round trip (3 sequential ones would cost 3x the RTT over a remote
 * DB). Reads only; Agent B never writes A's tables.
 */
export async function hydrateAmmunition(
  prisma: PrismaClient,
  callId: string,
): Promise<AmmunitionPayload | null> {
  const rows = await prisma.$queryRawUnsafe<AmmoRow[]>(
    `SELECT
       l.id AS lead_id, l."displayName" AS lead_name, l."priorityScore" AS priority_score,
       l."topMatchFit" AS top_match_fit, l."captureStatus" AS capture_status,
       l."matchReason" AS match_reason, l."dealflowDeepLink" AS deep_link,
       l."primaryAddressSummary" AS address_summary,
       c.id AS contact_id, c."displayName" AS contact_name,
       (SELECT json_agg(json_build_object(
           'id', p.id, 'phone', p.phone, 'phoneFormatted', p."phoneFormatted",
           'type', p.type, 'lineType', p."lineType") ORDER BY p."isPrimary" DESC)
         FROM "ContactPhone" p WHERE p."contactId" = c.id) AS phones,
       s.id AS signal_id, s."queueRank" AS queue_rank, s."queueReason" AS queue_reason,
       s."primaryMatchFit" AS primary_match_fit, s."primaryCaptureStatus" AS primary_capture_status,
       s."primaryMatchConfidence" AS primary_match_confidence
     FROM "Call" call
     LEFT JOIN "Lead" l ON l.id = call."leadId"
     LEFT JOIN "Contact" c ON c.id = call."contactId"
     LEFT JOIN "DealFlowDerivedSignal" s ON s."mojoId" = l."mojoId"
     WHERE call.id = $1`,
    callId,
  );
  const r = rows[0];
  if (!r) return null;

  return {
    lead: r.lead_id
      ? {
          id: r.lead_id,
          displayName: r.lead_name ?? "",
          priorityScore: r.priority_score,
          topMatchFit: r.top_match_fit,
          captureStatus: r.capture_status,
          matchReason: r.match_reason,
          dealflowDeepLink: r.deep_link,
          primaryAddressSummary: r.address_summary,
        }
      : null,
    contact: r.contact_id
      ? {
          id: r.contact_id,
          displayName: r.contact_name ?? "",
          phones: r.phones ?? [],
        }
      : null,
    derivedSignal: r.signal_id
      ? {
          queueRank: r.queue_rank,
          queueReason: r.queue_reason,
          primaryMatchFit: r.primary_match_fit,
          primaryCaptureStatus: r.primary_capture_status,
          primaryMatchConfidence: r.primary_match_confidence,
        }
      : null,
  };
}
