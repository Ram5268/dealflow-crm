import { randomUUID } from 'node:crypto'
import type { PrismaClient } from '@prisma/client'
import { prisma } from '@/lib/prisma'
import { DEFAULT_VIEW } from '@/lib/core-data/smart-view/defaultView'
import { IMPORT_SCORING_SOURCE } from '@/lib/core-data/dealflow-score/marker'
import type { DerivedSignalUpsert } from './sync'

// Brief 37 — applies one DealFlow batch to the CRM's OWN DB in ONE transaction,
// set-based (each statement takes the whole batch as one jsonb parameter):
// upsert signals, drop signals not in the batch, copy the ammunition onto batch
// leads (by crmLeadId, else mojoId), NULL it on every other lead, fill blank
// timezones, and create the default view and an UNCONFIRMED NY calling window
// if missing. Idempotent: re-running the same batch changes nothing.
// Brief 45 (PR F): the drop and the NULLing spare what an upload's scoring
// wrote after DealFlow generated the batch (the morning-sync guard below).
// Brief 50 (PR 11): only this organization's signals are written (another
// organization's signal with the same Mojo ID is left alone), the NULLing
// clears nothing for a batch that maps to no lead, and refuseBatch says when
// the morning copy should write nothing at all (run.ts).

// Timezone rule (planner-approved): America/New_York only when the property is
// in NY AND the mailing state lies wholly in the Eastern zone (or is missing).
// Blanks only, never overwritten, no area codes. Everyone else stays blank, so
// compliance keeps them uncallable (timezone_unresolved).
export const EASTERN_STATES = [
  'CT', 'DC', 'DE', 'GA', 'MA', 'MD', 'ME', 'NC', 'NH', 'NJ', 'NY', 'OH', 'PA', 'RI', 'SC', 'VA', 'VT', 'WV',
]
export const TIMEZONE_SOURCE = 'property+mailing_state'

const SIGNAL_COLUMNS =
  'id text, "mojoId" text, "queueRank" int, "priorityScore" int, "queueReason" text, "primaryMatchId" text, ' +
  '"primaryMatchFit" int, "primaryCaptureStatus" text, "primaryMatchConfidence" text, "dealflowRawJson" jsonb'

// Brief 50 (PR 11), engineering precaution (open item 6.10): a Mojo ID is
// unique across the whole table, so a signal another organization holds is
// left exactly as it is (neither moved into this organization nor
// overwritten); the copy writes only its own organization's rows. The same
// condition the upload scoring's upsert uses (dealflow-score/write.ts).
export const UPSERT_SAME_ORG_SQL = `
  WHERE "DealFlowDerivedSignal"."organizationId" = EXCLUDED."organizationId"`

// $1 = batch rows (jsonb), $2 = organizationId
export const UPSERT_SIGNALS_SQL = `
  INSERT INTO "DealFlowDerivedSignal" (id, "organizationId", "mojoId", "queueRank", "priorityScore", "queueReason",
    "primaryMatchId", "primaryMatchFit", "primaryCaptureStatus", "primaryMatchConfidence", "syncedAt", "dealflowRawJson")
  SELECT s.id, $2, s."mojoId", s."queueRank", s."priorityScore", s."queueReason", s."primaryMatchId",
    s."primaryMatchFit", s."primaryCaptureStatus", s."primaryMatchConfidence", now(), s."dealflowRawJson"
  FROM jsonb_to_recordset($1::jsonb) AS s(${SIGNAL_COLUMNS})
  ON CONFLICT ("mojoId") DO UPDATE SET
    "organizationId" = EXCLUDED."organizationId", "queueRank" = EXCLUDED."queueRank",
    "priorityScore" = EXCLUDED."priorityScore", "queueReason" = EXCLUDED."queueReason",
    "primaryMatchId" = EXCLUDED."primaryMatchId", "primaryMatchFit" = EXCLUDED."primaryMatchFit",
    "primaryCaptureStatus" = EXCLUDED."primaryCaptureStatus",
    "primaryMatchConfidence" = EXCLUDED."primaryMatchConfidence",
    "syncedAt" = now(), "dealflowRawJson" = EXCLUDED."dealflowRawJson"${UPSERT_SAME_ORG_SQL}`

// Brief 45 (PR F), the morning-sync guard (CONTRACT §7): DealFlow makes its
// list around 5:00 and this copy runs at 7:00. An upload's new people scored
// in between (dealflow-score/) aren't on that list, and clearing everyone
// missing from it would wipe them until the next night. So a lead or signal
// written after the batch's generatedAt ($3) is left as it is; one written
// before (or in the same millisecond) is cleared as it always was. With no
// batch time ($3 NULL) nothing is kept back. Both statements are otherwise
// unchanged (tests/unit/dealflow-sync-guard.test.ts pins their text).
export const MORNING_GUARD_SIGNALS_SQL = `
    AND ($3::timestamptz IS NULL OR "syncedAt" <= ($3::timestamptz AT TIME ZONE 'UTC'))`

export const REMOVE_STALE_SIGNALS_SQL = `
  DELETE FROM "DealFlowDerivedSignal"
  WHERE "organizationId" = $2
    AND "mojoId" NOT IN (SELECT s."mojoId" FROM jsonb_to_recordset($1::jsonb) AS s("mojoId" text))${MORNING_GUARD_SIGNALS_SQL}`

// Batch row → CRM lead: by crmLeadId when that lead exists, else by mojoId.
// One lead per row (the best-ranked row wins if two rows reach the same lead).
const MAPPED_LEADS = `
  WITH b AS (
    SELECT * FROM jsonb_to_recordset($1::jsonb) AS b("crmLeadId" text, "mojoId" text, "queueRank" int,
      "priorityScore" int, "primaryMatchFit" int, "primaryCaptureStatus" text, "matchReason" text, "dealflowDeepLink" text)
  ), mapped AS (
    SELECT DISTINCT ON (COALESCE(by_id.id, by_mojo.id)) COALESCE(by_id.id, by_mojo.id) AS lead_id, b.*
    FROM b
    LEFT JOIN "Lead" by_id ON by_id.id = b."crmLeadId" AND by_id."organizationId" = $2
    LEFT JOIN "Lead" by_mojo ON by_mojo."mojoId" = b."mojoId" AND by_mojo."organizationId" = $2
    WHERE COALESCE(by_id.id, by_mojo.id) IS NOT NULL
    ORDER BY COALESCE(by_id.id, by_mojo.id), b."queueRank" NULLS LAST
  )`

export const UPDATE_LEADS_SQL = `${MAPPED_LEADS}
  UPDATE "Lead" AS l SET "priorityScore" = m."priorityScore", "topMatchFit" = m."primaryMatchFit",
    "captureStatus" = m."primaryCaptureStatus", "matchReason" = m."matchReason",
    "dealflowDeepLink" = m."dealflowDeepLink", "dealflowSignalSyncedAt" = now()
  FROM mapped AS m
  WHERE l.id = m.lead_id`

// The guard for leads (see MORNING_GUARD_SIGNALS_SQL).
export const MORNING_GUARD_LEADS_SQL = `
    AND ($3::timestamptz IS NULL OR l."dealflowSignalSyncedAt" IS NULL
         OR l."dealflowSignalSyncedAt" <= ($3::timestamptz AT TIME ZONE 'UTC'))`

// Brief 50 (PR 11), engineering precaution (open item 6.10): a batch that maps
// to no lead of the organization clears nothing. The morning copy refuses such
// a batch before writing (refuseBatch below); this keeps the clear itself from
// ever blanking every lead, whoever calls it.
export const NOTHING_MAPPED_GUARD_SQL = `
    AND EXISTS (SELECT 1 FROM mapped)`

export const CLEAR_STALE_LEADS_SQL = `${MAPPED_LEADS}
  UPDATE "Lead" AS l SET "priorityScore" = NULL, "topMatchFit" = NULL, "captureStatus" = NULL,
    "matchReason" = NULL, "dealflowDeepLink" = NULL, "dealflowSignalSyncedAt" = NULL
  WHERE l."organizationId" = $2
    AND l.id NOT IN (SELECT lead_id FROM mapped)
    AND num_nonnulls(l."priorityScore", l."topMatchFit", l."captureStatus", l."matchReason",
                     l."dealflowDeepLink", l."dealflowSignalSyncedAt") > 0${MORNING_GUARD_LEADS_SQL}${NOTHING_MAPPED_GUARD_SQL}`

// Brief 50 (PR 11): how many of the organization's leads the batch reaches
// (MAPPED_LEADS, exactly as the writes map them), and how many signals the
// last morning copy left (an upload's scoring rows don't count:
// dealflow-score/marker.ts). $1 = batch rows as UPDATE_LEADS_SQL takes them,
// $2 = organizationId. Read-only.
export const BATCH_MAPPING_SQL = `${MAPPED_LEADS}
  SELECT (SELECT count(*) FROM mapped)::int AS "mappedLeads",
    (SELECT count(*) FROM "DealFlowDerivedSignal" s
      WHERE s."organizationId" = $2
        AND (s."dealflowRawJson"->>'source') IS DISTINCT FROM '${IMPORT_SCORING_SOURCE}')::int AS "morningSignals"`

const leadCustomField = (name: string) => `(
    SELECT upper(btrim(v."valueText")) FROM "CustomFieldValue" v
    JOIN "CustomFieldDefinition" d ON d.id = v."definitionId"
    WHERE d."organizationId" = $1 AND d."objectType" = 'lead' AND d.name = '${name}' AND v."objectId" = l.id
    LIMIT 1)`

// $1 = organizationId, $2 = EASTERN_STATES, $3 = TIMEZONE_SOURCE
export const FILL_TIMEZONES_SQL = `
  UPDATE "Contact" AS c SET timezone = 'America/New_York', "timezoneSource" = $3
  FROM "Lead" AS l
  WHERE c."leadId" = l.id AND l."organizationId" = $1
    AND COALESCE(btrim(c.timezone), '') = ''
    AND ${leadCustomField('Property State')} = 'NY'
    AND COALESCE(NULLIF(${leadCustomField('Mailing State')}, ''), 'NY') = ANY($2::text[])`

// $1 id, $2 organizationId, $3 name, $4 description, $5 sQuery, $6 sort
export const ENSURE_VIEW_SQL = `
  INSERT INTO "SavedView" (id, "organizationId", name, description, type, "sQuery", sort, "createdAt", "updatedAt")
  VALUES ($1, $2, $3, $4, 'lead', $5::jsonb, $6::jsonb, now(), now())
  ON CONFLICT (id) DO NOTHING`

// The CRM's code default (schema defaults): 09:00-20:00, Mon-Fri. Left
// UNCONFIRMED — only Ryan's counsel-backed confirm route may set policyConfirmedBy.
// $1 id, $2 organizationId
export const ENSURE_WINDOW_SQL = `
  INSERT INTO "CallingWindowConfig" (id, "organizationId", timezone, "earliestHour", "latestHour", "allowedDaysOfWeek", "updatedAt")
  VALUES ($1, $2, 'America/New_York', 9, 20, ARRAY[1, 2, 3, 4, 5], now())
  ON CONFLICT ("organizationId", timezone) DO NOTHING`

export interface ApplyResult {
  signalsUpserted: number
  signalsRemoved: number
  leadsUpdated: number
  leadsCleared: number
  timezonesSet: number
  viewCreated: boolean
  windowSeeded: boolean
}

/**
 * Brief 45 (PR F): when DealFlow generated this batch (ISO), for the morning-sync
 * guard; null when the rows don't say. Every row of one run carries the same
 * time (buildSignals copies it onto each).
 */
export function batchGeneratedAt(signals: DerivedSignalUpsert[]): string | null {
  let latest: number | null = null
  for (const s of signals) {
    const t = Date.parse(String(s.dealflowRawJson.generatedAt ?? ''))
    if (Number.isFinite(t) && (latest === null || t > latest)) latest = t
  }
  return latest === null ? null : new Date(latest).toISOString()
}

// The batch rows as the lead statements read them (no raw JSON).
const leadRows = (signals: DerivedSignalUpsert[]) => JSON.stringify(signals.map(({ dealflowRawJson: _raw, ...s }) => s))

export interface BatchMapping {
  mappedLeads: number // the organization's leads this batch reaches
  morningSignals: number // the signals the last morning copy left
}

export type BatchRefusal = 'no_leads_matched' | 'too_few_leads_matched'

/**
 * Brief 50 (PR 11), engineering precaution (open item 6.10): whether the
 * morning copy refuses this batch. The copy treats DealFlow's list as complete
 * and clears every lead missing from it, so a list that matches no lead would
 * blank the Queue, and one that matches only a few would blank most of it.
 * Refused: 0 leads; or fewer than half as many leads as the last morning's
 * list held signals (Brief 47's "fewer than half" rule for DealFlow's own
 * nightly). Today's list (~1,490 entries, ~1,478 of them CRM leads) passes
 * with about a 2x margin: a refusal needs fewer than ~745. A first copy (no
 * signals yet) is refused only when it matches no lead.
 */
export function refuseBatch({ mappedLeads, morningSignals }: BatchMapping): BatchRefusal | null {
  if (mappedLeads === 0) return 'no_leads_matched'
  if (mappedLeads * 2 < morningSignals) return 'too_few_leads_matched'
  return null
}

export async function countBatchMapping(
  organizationId: string,
  signals: DerivedSignalUpsert[],
  db: PrismaClient = prisma
): Promise<BatchMapping> {
  const [r] = await db.$queryRawUnsafe<BatchMapping[]>(BATCH_MAPPING_SQL, leadRows(signals), organizationId)
  return { mappedLeads: r?.mappedLeads ?? 0, morningSignals: r?.morningSignals ?? 0 }
}

// The statements in order, with their parameters. Exported so a dry run can
// replay exactly these inside a transaction it rolls back.
export function syncStatements(organizationId: string, signals: DerivedSignalUpsert[]): [string, ...unknown[]][] {
  // Each statement gets only the fields it reads (the raw JSON goes up once).
  const rows = JSON.stringify(signals.map((s) => ({ id: randomUUID(), ...s })))
  const leads = leadRows(signals)
  const mojoIds = JSON.stringify(signals.map((s) => ({ mojoId: s.mojoId })))
  const generatedAt = batchGeneratedAt(signals)
  const v = DEFAULT_VIEW
  return [
    [UPSERT_SIGNALS_SQL, rows, organizationId],
    [REMOVE_STALE_SIGNALS_SQL, mojoIds, organizationId, generatedAt],
    [UPDATE_LEADS_SQL, leads, organizationId],
    [CLEAR_STALE_LEADS_SQL, leads, organizationId, generatedAt],
    [FILL_TIMEZONES_SQL, organizationId, EASTERN_STATES, TIMEZONE_SOURCE],
    [ENSURE_VIEW_SQL, v.id, organizationId, v.name, v.description, JSON.stringify(v.sQuery), JSON.stringify(v.sort)],
    [ENSURE_WINDOW_SQL, randomUUID(), organizationId],
  ]
}

export function toApplyResult(counts: number[]): ApplyResult {
  const [signalsUpserted, signalsRemoved, leadsUpdated, leadsCleared, timezonesSet, view, window] = counts
  return { signalsUpserted, signalsRemoved, leadsUpdated, leadsCleared, timezonesSet, viewCreated: view > 0, windowSeeded: window > 0 }
}

export async function applySync(
  organizationId: string,
  signals: DerivedSignalUpsert[],
  db: PrismaClient = prisma
): Promise<ApplyResult> {
  const statements = syncStatements(organizationId, signals)
  return toApplyResult(await db.$transaction(statements.map(([sql, ...params]) => db.$executeRawUnsafe(sql, ...params))))
}
