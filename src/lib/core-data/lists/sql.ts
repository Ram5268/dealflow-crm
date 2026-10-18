// Brief 45 — shared server-side pieces for folders, lists, groups and the
// Pipeline: errors, the name-scope lock, time helpers, and the SQL that reads
// Mojo's custom fields by name [CONTRACT §4].
import { Prisma } from '@prisma/client'
import { HttpError } from '@/lib/shared/http'
import { nameProblem, normalizeName, ATTEMPTS_PATTERN_SQL } from './rules'
import { BULK_MAX } from './types'
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

/** max(syncedAt) and the newest DealFlow batch's generatedAt for the org [CONTRACT §3]. */
export function rankingTimesSql(organizationId: string): Prisma.Sql {
  return Prisma.sql`
    (SELECT max(s."syncedAt") FROM "DealFlowDerivedSignal" s WHERE s."organizationId" = ${organizationId}) AS "rankedAt",
    (SELECT max(CASE WHEN s."dealflowRawJson"->>'generatedAt' ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T'
                     THEN (s."dealflowRawJson"->>'generatedAt')::timestamptz END)
       FROM "DealFlowDerivedSignal" s WHERE s."organizationId" = ${organizationId}) AS "rankingCutoff"`
}
