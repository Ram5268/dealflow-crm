// Brief 45 — shared server-side pieces for folders, lists, groups and the
// Pipeline: errors, the name-scope lock, time helpers, and the SQL that reads
// Mojo's custom fields by name [CONTRACT §4].
import { Prisma } from '@prisma/client'
import { HttpError } from '@/lib/shared/http'
import { buyerName, toBuyers } from '@/lib/core-data/dealflow-sync/buyers'
import { nameProblem, normalizeName, ATTEMPTS_PATTERN_SQL } from './rules'
import { BULK_MAX, type BestBuyerDTO } from './types'
import { IMPORT_SCORING_SOURCE } from '@/lib/core-data/dealflow-score/marker'
import {
  CITY_BOROUGH, NYC_ZIP_NEIGHBORHOODS, PROPERTY_TYPE_UNITS, SINGLE_FAMILY_PATTERN, ZIP3_BOROUGH, ZIP5_BOROUGH,
} from './geo'

export type Tx = Prisma.TransactionClient

// Interactive transactions: the Railway link is slow (docs/known-drift.md),
// and a 5,000-lead bulk change writes up to 5,000 timeline rows.
export const TX = { maxWait: 10_000, timeout: 30_000 } as const

// ─── Errors (plain English: every screen shows the API's error text) ────────

export type Thing = 'Folder' | 'List' | 'Group' | 'Lead' | 'Workflow'
export const notFound = (what: Thing) => new HttpError(404, `${what} not found.`)
export const badRequest = (message: string) => new HttpError(400, message)
export const conflict = (message: string) => new HttpError(409, message)
export const STALE_ORDER = conflict('The order changed somewhere else. Reload and try again.')

/**
 * A membership insert that hit a foreign-key violation (Postgres 23503): the
 * list or group (or the lead) was deleted by another request after this one
 * checked it, e.g. a chip click racing a group delete, or a bulk add racing a
 * list delete. Answered with the same plain 404 as an unknown id, never a 500.
 * A raw query reports it as P2010 carrying the Postgres code; a Prisma call as
 * P2003. Returns null for any other error.
 */
export function deletedMeanwhile(
  err: unknown,
  table: 'ListMembership' | 'LeadGroupMembership',
  parent: 'List' | 'Group',
): HttpError | null {
  if (!(err instanceof Prisma.PrismaClientKnownRequestError)) return null
  const meta = (err.meta ?? {}) as { code?: unknown; message?: unknown; field_name?: unknown }
  if (err.code !== 'P2003' && !(err.code === 'P2010' && meta.code === '23503')) return null
  const detail = `${String(meta.message ?? '')} ${String(meta.field_name ?? '')} ${err.message}`
  return notFound(detail.includes(`${table}_leadId_fkey`) ? 'Lead' : parent)
}

/** A valid, normalized name, or a 400 with the plain-English reason. */
export function validName(raw: unknown): string {
  const problem = nameProblem(raw)
  if (problem) throw badRequest(problem)
  return normalizeName(raw as string)
}

/** Case-insensitive name equality, the same in every scope. */
export const nameKey = (name: string) => normalizeName(name).toLowerCase()

export function findClash<T extends { id: string; name: string }>(rows: T[], name: string, selfId: string | null): T | undefined {
  const key = nameKey(name)
  return rows.find((r) => r.id !== selfId && nameKey(r.name) === key)
}

// [engineering precaution] bigger selections are chunked by the UI.
export function uniqueIds(ids: readonly string[]): string[] {
  if (ids.length > BULK_MAX) {
    throw badRequest(`That's too many people at once: change at most ${BULK_MAX.toLocaleString('en-US')} per request.`)
  }
  return [...new Set(ids)]
}

/** For reorder: the same ids, each once, nothing missing or extra. */
export function sameSet(current: string[], proposed: string[]): boolean {
  if (current.length !== proposed.length || new Set(proposed).size !== proposed.length) return false
  const have = new Set(current)
  return proposed.every((id) => have.has(id))
}

/**
 * Serializes name checks within one scope (CONTRACT §2): two requests that
 * create the same name at once can't both pass the uniqueness check. Held
 * until the transaction ends.
 */
export async function lockScope(tx: Tx, organizationId: string, scope: string): Promise<void> {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`b45:${organizationId}:${scope}`}))`
}
export const FOLDER_SCOPE = 'folder'
export const GROUP_SCOPE = 'group'
export const WORKFLOW_SCOPE = 'workflow'
export const listScope = (folderId: string | null) => `list:${folderId ?? 'root'}`

// ─── Time ────────────────────────────────────────────────────────────────────
// Prisma's DateTime columns are `timestamp(3)` holding UTC wall time, and a JS
// Date travels as `timestamptz`. Comparing or writing them directly would go
// through the session's TimeZone, so every raw statement converts explicitly.

/** A JS Date as a UTC `timestamp`, comparable with (and writable to) DateTime columns. */
export const utc = (d: Date) => Prisma.sql`(${d.toISOString()}::timestamptz AT TIME ZONE 'UTC')`

export const NY = 'America/New_York'

// ─── Mojo custom fields, read by name (never written) [CONTRACT §4] ─────────

export const FIELD = {
  attempts: 'Call Attempts',
  lastResult: 'Last Call Result',
  lastDial: 'Last Dial Date',
  lastContacted: 'Last Contacted Date',
  zip: 'Property Zip Code',
  city: 'Property City',
  propertyType: 'Property Type',
} as const

/**
 * `defs`: one row holding the org's definition id for each field above (NULL
 * when the org has no such field, which then means "no value" for everyone).
 */
export function defsCte(organizationId: string): Prisma.Sql {
  return Prisma.sql`defs AS (
    SELECT
      max(d.id) FILTER (WHERE d.name = ${FIELD.attempts}) AS attempts,
      max(d.id) FILTER (WHERE d.name = ${FIELD.lastResult}) AS last_result,
      max(d.id) FILTER (WHERE d.name = ${FIELD.lastDial}) AS last_dial,
      max(d.id) FILTER (WHERE d.name = ${FIELD.lastContacted}) AS last_contacted,
      max(d.id) FILTER (WHERE d.name = ${FIELD.zip}) AS zip,
      max(d.id) FILTER (WHERE d.name = ${FIELD.city}) AS city,
      max(d.id) FILTER (WHERE d.name = ${FIELD.propertyType}) AS property_type
    FROM "CustomFieldDefinition" d
    WHERE d."organizationId" = ${organizationId} AND d."objectType" = 'lead'
  )`
}

type DefColumn = 'attempts' | 'last_result' | 'last_dial' | 'last_contacted' | 'zip' | 'city' | 'property_type'

// Each value is read with one lookup on CustomFieldValue's unique
// (definitionId, objectId) index per lead. A correlated subquery always gets
// that plan; a join can be planned as a scan per lead when statistics are
// stale (right after a big upload), which is far too slow on a big list.

/** One field's value for a lead (leadExpr is SQL such as `l.id`). */
export function fieldValue(def: DefColumn, column: 'valueText' | 'valueNumber' | 'valueDate', leadExpr: string): Prisma.Sql {
  return Prisma.raw(
    `(SELECT v."${column}" FROM "CustomFieldValue" v WHERE v."definitionId" = (SELECT ${def} FROM defs) AND v."objectId" = ${leadExpr})`,
  )
}

/** Call attempts: valueNumber, else strictly numeric text, else 0 (rules.ts attemptsFrom). */
export function attemptsOf(leadExpr: string): Prisma.Sql {
  return Prisma.sql`COALESCE((SELECT COALESCE(v."valueNumber", (regexp_match(v."valueText", ${ATTEMPTS_PATTERN_SQL}))[1]::float8)
      FROM "CustomFieldValue" v WHERE v."definitionId" = (SELECT attempts FROM defs) AND v."objectId" = ${Prisma.raw(leadExpr)}), 0)::float8`
}

/** The ZIP as text (a number-typed ZIP is padded back to 5 digits). */
export function zipOf(leadExpr: string): Prisma.Sql {
  return Prisma.raw(
    `(SELECT COALESCE(NULLIF(btrim(v."valueText"), ''), CASE WHEN v."valueNumber" >= 0 AND v."valueNumber" < 100000 ` +
      `THEN lpad(trunc(v."valueNumber")::int::text, 5, '0') END) ` +
      `FROM "CustomFieldValue" v WHERE v."definitionId" = (SELECT zip FROM defs) AND v."objectId" = ${leadExpr})`,
  )
}

/**
 * The org check on a lead joined from a membership row. Deliberately not an
 * index condition: with stale statistics Postgres could otherwise re-scan
 * every lead of the org once per member. As written it can only look each
 * member up by id. Same rows either way.
 */
export function leadInOrg(leadAlias: string, organizationId: string): Prisma.Sql {
  return Prisma.sql`(${Prisma.raw(`${leadAlias}."organizationId"`)} = ${organizationId}) IS TRUE`
}

// geo.ts, in SQL. Same tables, passed as arrays.
const ZIP5_PATTERN = '^[[:space:]]*([0-9]{5})(-[0-9]{4})?\\y'
const zip5Sql = (zipText: Prisma.Sql) => Prisma.sql`substring(${zipText} from ${ZIP5_PATTERN})`
/** Whitespace collapsed and trimmed, like geo.ts cleanText(). */
export const cleanSql = (text: Prisma.Sql) => Prisma.sql`btrim(regexp_replace(${text}, ${'\\s+'}, ' ', 'g'))`

const entries = <V>(o: Record<string, V>) => [Object.keys(o), Object.values(o)] as const
const [Z5K, Z5V] = entries(ZIP5_BOROUGH)
const [Z3K, Z3V] = entries(ZIP3_BOROUGH)
const CITY_PAIRS = Object.entries(CITY_BOROUGH).flatMap(([b, names]) => names.map((n) => [n, b] as const))
const CITY_K = CITY_PAIRS.map(([n]) => n)
const CITY_V = CITY_PAIRS.map(([, b]) => b)
const [NBK, NBV] = entries(NYC_ZIP_NEIGHBORHOODS)
const [UK, UV] = entries(PROPERTY_TYPE_UNITS)

export function boroughSql(zipText: Prisma.Sql, cityText: Prisma.Sql): Prisma.Sql {
  const z5 = zip5Sql(zipText)
  const city = Prisma.sql`lower(${cleanSql(cityText)})`
  return Prisma.sql`COALESCE(
    (${Z5V}::text[])[array_position(${Z5K}::text[], ${z5})],
    (${Z3V}::text[])[array_position(${Z3K}::text[], left(${z5}, 3))],
    (${CITY_V}::text[])[array_position(${CITY_K}::text[], ${city})]
  )`
}

export function neighborhoodSql(zipText: Prisma.Sql): Prisma.Sql {
  return Prisma.sql`(${NBV}::text[])[array_position(${NBK}::text[], ${zip5Sql(zipText)})]`
}

export function unitsSql(propertyType: Prisma.Sql): Prisma.Sql {
  const t = cleanSql(propertyType)
  return Prisma.sql`COALESCE(
    (${UV}::int[])[array_position(${UK}::text[], ${t})],
    CASE WHEN lower(${t}) LIKE ${`%${SINGLE_FAMILY_PATTERN}%`} THEN 1 END
  )`
}

/** ILIKE pattern for a search box term: % and _ are literal. */
export function likePattern(term: string): string {
  return `%${term.replace(/[\\%_]/g, (c) => `\\${c}`)}%`
}

/** A lead's group chips in sidebar order, as JSON (no timestamps inside). */
export function groupChipsSql(leadExpr: string): Prisma.Sql {
  return Prisma.raw(`(SELECT COALESCE(json_agg(json_build_object('id', g.id, 'name', g.name, 'color', g.color)
      ORDER BY g."sortOrder", g."createdAt", g.id), '[]'::json)
    FROM "LeadGroupMembership" gm JOIN "LeadGroup" g ON g.id = gm."groupId" WHERE gm."leadId" = ${leadExpr})`)
}

// ─── Best buyer, for one page of leads ───────────────────────────────────────
// The first buyer DealFlow stored on the signal whose recorded CRM lead id is
// this lead (the best-ranked one if DealFlow named the lead twice), else on the
// signal with this lead's Mojo ID unless DealFlow gave that signal to another
// lead of the org. Those are the lead page's rules (getLeadBuyers in
// dealflow-sync/buyer-lookup.ts), with bestBuyerLookup's preference for the
// signal that names the lead. Only this page's signals are read: the whole
// org's is ~1.7 MB at 4,500 signals, the slowest part of a list page on the
// Railway link.
const VALID_BEST = Prisma.raw(
  `jsonb_typeof(s."dealflowRawJson"->'buyers'->0->'matchId') = 'string' AND btrim(s."dealflowRawJson"->'buyers'->0->>'matchId') <> ''`,
)

/** CTEs best_by_lead and best_by_mojo for the leads (id, "mojoId") of CTE `pageCte`. */
export function bestBuyerCtes(organizationId: string, pageCte: string): Prisma.Sql {
  const page = Prisma.raw(pageCte)
  return Prisma.sql`best_by_lead AS (
    SELECT DISTINCT ON (s."dealflowRawJson"->>'crmLeadId') s."dealflowRawJson"->>'crmLeadId' AS lead_id,
      s."dealflowRawJson"->'buyers'->0 AS best
    FROM "DealFlowDerivedSignal" s
    WHERE s."organizationId" = ${organizationId} AND ${VALID_BEST}
      AND s."dealflowRawJson"->>'crmLeadId' IN (SELECT id FROM ${page})
    ORDER BY s."dealflowRawJson"->>'crmLeadId', s."queueRank" NULLS LAST, s.id
  ),
  best_by_mojo AS (
    SELECT s."mojoId", s."dealflowRawJson"->'buyers'->0 AS best
    FROM "DealFlowDerivedSignal" s
    WHERE s."organizationId" = ${organizationId} AND ${VALID_BEST}
      AND s."mojoId" IN (SELECT "mojoId" FROM ${page} WHERE "mojoId" IS NOT NULL)
      -- Not when DealFlow named another lead of this org for this signal: that
      -- lead has it (as the sync and the lead page assign it).
      AND NOT EXISTS (SELECT 1 FROM "Lead" o
        WHERE o.id = s."dealflowRawJson"->>'crmLeadId' AND o."organizationId" = ${organizationId})
  )`
}

/** Joins for bestBuyerCtes; select `COALESCE(bl.best, bm.best)`. */
export function bestBuyerJoins(leadAlias: string): Prisma.Sql {
  return Prisma.raw(
    `LEFT JOIN best_by_lead bl ON bl.lead_id = ${leadAlias}.id LEFT JOIN best_by_mojo bm ON bm."mojoId" = ${leadAlias}."mojoId"`,
  )
}

/** The stored buyer as the page shows it: a name, a score, and whether it's test data. Never a phone or email. */
export function bestBuyerDTO(raw: unknown): BestBuyerDTO | null {
  const [b] = toBuyers([raw])
  return b ? { name: buyerName(b), score: b.score, isTestData: b.isTestData } : null
}

/**
 * A signal the morning sync copied, not one an upload's scoring wrote
 * (Brief 45 PR F, dealflow-score/marker.ts).
 */
export function morningSignal(alias: string): Prisma.Sql {
  return Prisma.sql`(${Prisma.raw(alias)}."dealflowRawJson"->>'source') IS DISTINCT FROM ${IMPORT_SCORING_SOURCE}`
}

/**
 * max(syncedAt) and the newest DealFlow batch's generatedAt for the org
 * [CONTRACT §3]. Both are the morning update's clocks, so rows an upload's
 * scoring wrote at other times of day are left out: "ranked 7:02" stays the
 * morning's, and a lead that arrived since the morning still shows
 * "scoring…" until it is scored [Brief 45 PR F; engineering precaution].
 */
export function rankingTimesSql(organizationId: string): Prisma.Sql {
  return Prisma.sql`
    (SELECT max(s."syncedAt") FROM "DealFlowDerivedSignal" s
       WHERE s."organizationId" = ${organizationId} AND ${morningSignal('s')}) AS "rankedAt",
    (SELECT max(CASE WHEN s."dealflowRawJson"->>'generatedAt' ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T'
                     THEN (s."dealflowRawJson"->>'generatedAt')::timestamptz END)
       FROM "DealFlowDerivedSignal" s WHERE s."organizationId" = ${organizationId} AND ${morningSignal('s')}) AS "rankingCutoff"`
}
