// Brief 45 — the Pipeline page's data [brief §5.6; CONTRACT §6b]: one column
// per group (board) or one row per lead (table), with the filters Ryan asked
// for. Organization only: nothing here contacts anyone.
//
// Filter → data mapping (also in the PR description):
//   list / folder   membership in that list / any active list of that folder
//   borough         "Property Zip Code" (first digits), else "Property City" (geo.ts)
//   neighborhood    "Property Zip Code" via the copy of DealFlow's ZIP table
//   propertyType    "Property Type" text; units from it as DealFlow's mapLead
//   tier            topMatchFit: hot ≥ 80, warm ≥ 65, possible below, none = no match
//   strongBuyer     topMatchFit ≥ 80
//   lastContact     later of "Last Contacted Date" and the newest Call/Email/SMS
//                   activity (never a Group entry)
//   taskDue         an open task due today / by this Sunday / before today (New York dates)
//   timeInGroup     joined the column's group (table: any shown group) at least N days ago
//   multiGroup      in two or more groups
// Value range is not offered until Brief 44's estimates are in the CRM.
// Sensitive life details are never filters [engineering precaution; fair-housing
// and NY human-rights law].
import { z } from 'zod'
import { Prisma, type PrismaClient } from '@prisma/client'
import { DateTime } from 'luxon'
import { prisma } from '@/lib/prisma'
import { bestBuyerLookup } from '@/lib/core-data/dealflow-sync/buyer-lookup'
import { buyerName } from '@/lib/core-data/dealflow-sync/buyers'
import {
  BOARD_PAGE_SIZE, BOROUGHS, PAGE_SIZE, PIPELINE_SORT_KEYS, PIPELINE_VIEWS,
  type BestBuyerDTO, type GroupChipDTO, type PipelineCard, type PipelineColumn, type PipelineFilterOptions,
  type PipelineFilters, type PipelineQuery, type PipelineResult, type PipelineRow, type PipelineSortKey, type SortDir,
} from './types'
import { HOT_MIN_FIT, STRONG_BUYER_MIN_FIT, WARM_MIN_FIT } from './rules'
import { NEIGHBORHOODS, cleanText } from './geo'
import { listGroups } from './groups'
import {
  FIELD, NY, attemptsOf, badRequest, boroughSql, cleanSql, defsCte, fieldValue, groupChipsSql, leadInOrg, likePattern,
  neighborhoodSql, unitsSql, utc, zipOf,
} from './sql'

// ─── The filters, as the query string spells them ────────────────────────────

const UNITS = ['1', '2', '3', '4', '5+'] as const
const TIERS = ['hot', 'warm', 'possible', 'none'] as const
const LAST_CONTACT = ['never', 'over7', 'over30', 'over60', 'over90'] as const
const TASK_DUE = ['today', 'week', 'overdue'] as const
const TIME_IN_GROUP = ['30', '60', '90'] as const
const id = z.string().min(1).max(64)

/** A saved workflow's filters: exactly these keys, nothing else [CONTRACT §6b]. */
export const pipelineFiltersSchema = z.strictObject({
  list: id.optional(),
  folder: id.optional(),
  borough: z.enum(BOROUGHS).optional(),
  neighborhood: z.string().refine((n) => NEIGHBORHOODS.includes(n), 'Unknown neighborhood.').optional(),
  propertyType: z.string().min(1).max(200).optional(),
  units: z.enum(UNITS).optional(),
  tier: z.enum(TIERS).optional(),
  strongBuyer: z.literal('1').optional(),
  lastContact: z.enum(LAST_CONTACT).optional(),
  taskDue: z.enum(TASK_DUE).optional(),
  timeInGroup: z.enum(TIME_IN_GROUP).optional(),
  multiGroup: z.literal('1').optional(),
  q: z.string().max(200).optional(),
})

function oneOf<T extends string>(value: string | undefined, allowed: readonly T[], what: string): T | undefined {
  if (value === undefined) return undefined
  if ((allowed as readonly string[]).includes(value)) return value as T
  throw badRequest(`Unknown ${what}: ${value.slice(0, 40)}.`)
}

function flag(value: string | undefined, what: string): '1' | undefined {
  if (value === undefined || value === '0' || value === 'false') return undefined
  if (value === '1' || value === 'true') return '1'
  throw badRequest(`Unknown ${what}: ${value.slice(0, 40)}.`)
}

/** GET /api/core-data/pipeline's query string → a PipelineQuery (400 on anything unknown). */
export function parsePipelineQuery(sp: URLSearchParams): PipelineQuery {
  for (const key of ['value', 'valueMin', 'valueMax']) {
    if (sp.has(key)) throw badRequest("Filtering by value isn't available yet: our estimates aren't in the CRM.")
  }
  const get = (key: string) => sp.get(key)?.trim() || undefined
  const filters: PipelineFilters = {}
  const set = <K extends keyof PipelineFilters>(key: K, value: PipelineFilters[K] | undefined) => {
    if (value !== undefined) filters[key] = value
  }
  set('list', get('list'))
  set('folder', get('folder'))
  const borough = get('borough')
  if (borough) {
    const canonical = BOROUGHS.find((b) => b.toLowerCase() === borough.toLowerCase())
    if (!canonical) throw badRequest(`Unknown borough: ${borough.slice(0, 40)}.`)
    set('borough', canonical)
  }
  const neighborhood = get('neighborhood')
  if (neighborhood) {
    const canonical = NEIGHBORHOODS.find((n) => n.toLowerCase() === neighborhood.toLowerCase())
    if (!canonical) throw badRequest(`Unknown neighborhood: ${neighborhood.slice(0, 40)}.`)
    set('neighborhood', canonical)
  }
  const propertyType = get('propertyType')
  if (propertyType) set('propertyType', cleanText(propertyType))
  set('units', oneOf(get('units'), UNITS, 'unit count'))
  set('tier', oneOf(get('tier'), TIERS, 'tier'))
  set('strongBuyer', flag(get('strongBuyer'), 'strong-buyer filter'))
  set('lastContact', oneOf(get('lastContact'), LAST_CONTACT, 'last-contact filter'))
  set('taskDue', oneOf(get('taskDue'), TASK_DUE, 'task filter'))
  set('timeInGroup', oneOf(get('timeInGroup'), TIME_IN_GROUP, 'time-in-group filter'))
  set('multiGroup', flag(get('multiGroup'), 'multi-group filter'))
  set('q', get('q'))
  const page = Number.parseInt(get('page') ?? '1', 10)
  return {
    view: oneOf(get('view'), PIPELINE_VIEWS, 'view') ?? 'board',
    groups: get('groups')?.split(',').map((g) => g.trim()).filter(Boolean),
    filters,
    column: get('column'),
    page: Number.isInteger(page) && page >= 1 ? page : 1,
    sort: oneOf(get('sort'), PIPELINE_SORT_KEYS, 'sort'),
    dir: oneOf(get('dir'), ['asc', 'desc'] as const, 'sort direction'),
  }
}

// ─── SQL ─────────────────────────────────────────────────────────────────────

interface Ctx {
  org: string
  shown: string[]
  filters: PipelineFilters
  now: Date
  today: string
  sunday: string
}

const CONTACT_TYPES = ['Call', 'Email', 'SMS'] // never 'Group' [CONTRACT §5]
// "Last Contacted Date" holds a New York wall-clock date; task due dates are instants.
const NY_SQL = Prisma.raw(`'${NY}'`)
const daysAgo = (now: Date, days: number) => new Date(now.getTime() - days * 86_400_000)

// defs → allrank (every lead's All-leads rank) → cand (one row per shown
// group and member) → open tasks (one pass: due flags and the next task per
// lead) → info (per lead: what the filters read).
function ctes(ctx: Ctx): Prisma.Sql {
  return Prisma.sql`WITH ${defsCte(ctx.org)},
  allrank AS (
    SELECT b.id, (row_number() OVER (ORDER BY b."priorityScore" DESC NULLS LAST, b."topMatchFit" DESC NULLS LAST,
      b.attempts ASC, b."createdAt" ASC, b.id COLLATE "C" ASC))::int AS rank
    FROM (SELECT l.id, l."priorityScore", l."topMatchFit", l."createdAt", ${attemptsOf('l.id')} AS attempts
          FROM "Lead" l WHERE l."organizationId" = ${ctx.org}) b
  ),
  cand AS (
    SELECT gm."groupId" AS group_id, gm."addedAt" AS added_at, gm."leadId" AS id
    FROM "LeadGroupMembership" gm JOIN "LeadGroup" g ON g.id = gm."groupId" AND g."organizationId" = ${ctx.org}
    WHERE gm."groupId" = ANY(${ctx.shown}::text[])
  ),
  open_tasks AS (
    SELECT t."leadId", t.text, t."dueDate", t."createdAt", t.id,
      ((t."dueDate" AT TIME ZONE 'UTC') AT TIME ZONE ${NY_SQL})::date AS due_day
    FROM "Task" t WHERE t."organizationId" = ${ctx.org} AND NOT t."isComplete" AND t."leadId" IS NOT NULL
  ),
  task_agg AS (
    SELECT "leadId", min("dueDate") AS next_due,
      bool_or(due_day = ${ctx.today}::date) AS due_today,
      bool_or(due_day BETWEEN ${ctx.today}::date AND ${ctx.sunday}::date) AS due_week,
      bool_or(due_day < ${ctx.today}::date) AS overdue
    FROM open_tasks GROUP BY "leadId"
  ),
  task_next AS (
    SELECT DISTINCT ON ("leadId") "leadId", text, "dueDate"
    FROM open_tasks ORDER BY "leadId", "dueDate" ASC NULLS LAST, "createdAt" ASC, id COLLATE "C"
  ),
  info AS (
    SELECT l.id, l."displayName", l."primaryAddressSummary", l."priorityScore", l."topMatchFit", l."mojoId", ar.rank,
      ${zipOf('l.id')} AS zip_text, ${fieldValue('city', 'valueText', 'l.id')} AS city_text,
      ${fieldValue('property_type', 'valueText', 'l.id')} AS ptype,
      GREATEST(${fieldValue('last_contacted', 'valueDate', 'l.id')} AT TIME ZONE ${NY_SQL},
        (SELECT max(a."activityAt") FROM "Activity" a
          WHERE a."leadId" = l.id AND ${activityInOrg(ctx.org)} AND a.type = ANY(${CONTACT_TYPES}::text[])) AT TIME ZONE 'UTC'
      ) AS last_contact_at,
      (SELECT count(*)::int FROM "LeadGroupMembership" g2 WHERE g2."leadId" = l.id) AS group_count,
      ta.next_due, COALESCE(ta.due_today, false) AS due_today, COALESCE(ta.due_week, false) AS due_week,
      COALESCE(ta.overdue, false) AS overdue
    FROM (SELECT DISTINCT id FROM cand) c
    JOIN "Lead" l ON l.id = c.id
    JOIN allrank ar ON ar.id = l.id
    LEFT JOIN task_agg ta ON ta."leadId" = l.id
    WHERE ${leadInOrg('l', ctx.org)}
  )`
}

// Not an index condition (see leadInOrg): the lead's own activity index is the
// cheap way in; ANDing it with the org's index scans every org activity per lead.
const activityInOrg = (org: string) => Prisma.sql`(a."organizationId" = ${org}) IS TRUE`

/** Conditions on one lead (alias i). */
function leadConditions(ctx: Ctx): Prisma.Sql[] {
  const f = ctx.filters
  const conds: Prisma.Sql[] = []
  if (f.q?.trim()) {
    const p = likePattern(f.q.trim())
    conds.push(Prisma.sql`(i."displayName" ILIKE ${p} OR i."primaryAddressSummary" ILIKE ${p})`)
  }
  if (f.list) {
    conds.push(Prisma.sql`EXISTS (SELECT 1 FROM "ListMembership" m JOIN "CallList" cl ON cl.id = m."listId"
      WHERE m."leadId" = i.id AND cl.id = ${f.list} AND cl."organizationId" = ${ctx.org})`)
  }
  if (f.folder) {
    // The folder's active lists: archived ones sit under "Archived", not in the folder.
    conds.push(Prisma.sql`EXISTS (SELECT 1 FROM "ListMembership" m JOIN "CallList" cl ON cl.id = m."listId"
      WHERE m."leadId" = i.id AND cl."folderId" = ${f.folder} AND cl."archivedAt" IS NULL AND cl."organizationId" = ${ctx.org})`)
  }
  if (f.borough) conds.push(Prisma.sql`${boroughSql(Prisma.raw('i.zip_text'), Prisma.raw('i.city_text'))} = ${f.borough}`)
  if (f.neighborhood) conds.push(Prisma.sql`${neighborhoodSql(Prisma.raw('i.zip_text'))} = ${f.neighborhood}`)
  if (f.propertyType) conds.push(Prisma.sql`${cleanSql(Prisma.raw('i.ptype'))} = ${f.propertyType}`)
  if (f.units) {
    const units = unitsSql(Prisma.raw('i.ptype'))
    conds.push(f.units === '5+' ? Prisma.sql`${units} >= 5` : Prisma.sql`${units} = ${Number(f.units)}`)
  }
  if (f.tier === 'hot') conds.push(Prisma.sql`i."topMatchFit" >= ${HOT_MIN_FIT}`)
  if (f.tier === 'warm') conds.push(Prisma.sql`i."topMatchFit" >= ${WARM_MIN_FIT} AND i."topMatchFit" < ${HOT_MIN_FIT}`)
  if (f.tier === 'possible') conds.push(Prisma.sql`i."topMatchFit" < ${WARM_MIN_FIT}`)
  if (f.tier === 'none') conds.push(Prisma.sql`i."topMatchFit" IS NULL`)
  if (f.strongBuyer) conds.push(Prisma.sql`i."topMatchFit" >= ${STRONG_BUYER_MIN_FIT}`)
  if (f.lastContact === 'never') conds.push(Prisma.sql`i.last_contact_at IS NULL`)
  else if (f.lastContact) {
    const days = Number(f.lastContact.slice('over'.length))
    conds.push(Prisma.sql`i.last_contact_at < ${daysAgo(ctx.now, days).toISOString()}::timestamptz`)
  }
  if (f.taskDue === 'today') conds.push(Prisma.sql`i.due_today`)
  if (f.taskDue === 'week') conds.push(Prisma.sql`i.due_week`)
  if (f.taskDue === 'overdue') conds.push(Prisma.sql`i.overdue`)
  if (f.multiGroup) conds.push(Prisma.sql`i.group_count >= 2`)
  return conds
}

function timeInGroup(ctx: Ctx, column: string): Prisma.Sql[] {
  if (!ctx.filters.timeInGroup) return []
  return [Prisma.sql`${Prisma.raw(column)} <= ${utc(daysAgo(ctx.now, Number(ctx.filters.timeInGroup)))}`]
}

const and = (conds: Prisma.Sql[]) => (conds.length ? Prisma.join(conds, ' AND ') : Prisma.sql`TRUE`)

// The lead's next open task: the earliest due date, then the oldest.
const nextTaskJoin = (lead: string) => Prisma.raw(`LEFT JOIN task_next nt ON nt."leadId" = ${lead}`)

interface CardSql {
  group_id: string
  col_count: number
  id: string | null
  displayName: string
  address: string | null
  added_at: Date
  rank: number
  mojoId: string | null
  last_contact_at: Date | null
  groups: GroupChipDTO[]
  next_text: string | null
  next_due_date: Date | null
}

interface RowSql extends Omit<CardSql, 'group_id' | 'col_count' | 'added_at'> {
  total: number
  in_group_since: Date
  priorityScore: number | null
  topMatchFit: number | null
}

function sortSql(alias: string, key: PipelineSortKey, dir: SortDir): Prisma.Sql {
  const d = dir === 'desc' ? 'DESC' : 'ASC'
  const col: Record<PipelineSortKey, string> = {
    rank: `${alias}.rank ${d}`,
    name: `lower(${alias}."displayName") ${d}, ${alias}.rank`,
    lastContact: `${alias}.last_contact_at ${d} NULLS LAST, ${alias}.rank`,
    taskDue: `${alias}.next_due ${d} NULLS LAST, ${alias}.rank`,
    inGroupSince: `${alias}.in_group_since ${d}, ${alias}.rank`,
  }
  return Prisma.raw(col[key])
}

// ─── The query ───────────────────────────────────────────────────────────────

export async function getPipeline(
  organizationId: string,
  query: PipelineQuery,
  opts: { now?: Date } = {},
  db: PrismaClient = prisma,
): Promise<PipelineResult> {
  const now = opts.now ?? new Date()
  const today = DateTime.fromJSDate(now).setZone(NY).startOf('day')
  const sunday = today.plus({ days: (7 - today.weekday) % 7 })
  const groups = await listGroups(organizationId, db)
  // Columns in sidebar order, whatever order they were asked in; another
  // org's or an unknown group is ignored.
  const wanted = query.groups ? new Set(query.groups) : null
  const shownGroups = groups.filter((g) => !wanted || wanted.has(g.id))
  const ctx: Ctx = {
    org: organizationId,
    shown: shownGroups.map((g) => g.id),
    filters: query.filters,
    now,
    today: today.toISODate()!,
    sunday: sunday.toISODate()!,
  }
  const [best, filterOptions] = await Promise.all([bestBuyerLookup(organizationId, db), loadFilterOptions(organizationId, db)])
  const bestOf = (leadId: string, mojoId: string | null): BestBuyerDTO | null => {
    const b = best({ leadId, mojoId })
    return b ? { name: buyerName(b), score: b.score, isTestData: b.isTestData } : null
  }
  const nextTask = (r: { next_text: string | null; next_due_date: Date | null }) =>
    r.next_text === null ? null : { text: r.next_text, dueDate: r.next_due_date?.toISOString() ?? null }

  if (query.view === 'table') {
    const page = query.page && query.page >= 1 ? query.page : 1
    if (ctx.shown.length === 0) return { view: 'table', rows: [], total: 0, page, pageSize: PAGE_SIZE, filterOptions }
    const sort = query.sort ?? 'rank'
    const dir = query.dir ?? 'asc'
    const rows = await db.$queryRaw<RowSql[]>`${ctes(ctx)},
      per_lead AS (SELECT c.id, min(c.added_at) AS in_group_since FROM cand c GROUP BY c.id),
      f AS (SELECT p.in_group_since, i.* FROM per_lead p JOIN info i ON i.id = p.id
            WHERE ${and([...leadConditions(ctx), ...timeInGroup(ctx, 'p.in_group_since')])}),
      page AS (SELECT * FROM f ORDER BY ${sortSql('f', sort, dir)} LIMIT ${PAGE_SIZE} OFFSET ${(page - 1) * PAGE_SIZE})
      SELECT t.total, p.id, p."displayName", p."primaryAddressSummary" AS address, p.in_group_since, p.rank, p."mojoId",
        p."priorityScore", p."topMatchFit", p.last_contact_at, p.next_due,
        ${groupChipsSql('p.id')} AS groups, nt.text AS next_text, nt."dueDate" AS next_due_date
      FROM (SELECT count(*)::int AS total FROM f) t
      LEFT JOIN page p ON true
      ${nextTaskJoin('p.id')}
      ORDER BY ${sortSql('p', sort, dir)}`
    const out: PipelineRow[] = rows.filter((r) => r.id !== null).map((r) => ({
      leadId: r.id as string,
      displayName: r.displayName,
      address: r.address,
      value: null,
      bestBuyer: bestOf(r.id as string, r.mojoId),
      lastContactAt: r.last_contact_at?.toISOString() ?? null,
      nextTask: nextTask(r),
      inGroupSince: r.in_group_since.toISOString(),
      groups: r.groups ?? [],
      rank: r.rank,
      priorityScore: r.priorityScore,
      topMatchFit: r.topMatchFit,
    }))
    return { view: 'table', rows: out, total: rows[0]?.total ?? 0, page, pageSize: PAGE_SIZE, filterOptions }
  }

  // Board: one column per shown group; `column` + `page` loads more of one.
  const columnGroups = query.column ? shownGroups.filter((g) => g.id === query.column) : shownGroups
  const page = query.column && query.page && query.page >= 1 ? query.page : 1
  if (columnGroups.length === 0) return { view: 'board', columns: [], filterOptions }
  const offset = (page - 1) * BOARD_PAGE_SIZE
  const columnIds = columnGroups.map((g) => g.id)
  const cards = await db.$queryRaw<CardSql[]>`${ctes({ ...ctx, shown: columnIds })},
    f AS (SELECT c.group_id, c.added_at, i.* FROM cand c JOIN info i ON i.id = c.id
          WHERE ${and([...leadConditions(ctx), ...timeInGroup(ctx, 'c.added_at')])}),
    numbered AS (SELECT f.*, (row_number() OVER (PARTITION BY f.group_id ORDER BY f.rank))::int AS pos FROM f),
    counts AS (SELECT group_id, count(*)::int AS n FROM f GROUP BY group_id)
    SELECT g.gid AS group_id, COALESCE(counts.n, 0) AS col_count, n.id, n."displayName", n."primaryAddressSummary" AS address,
      n.added_at, n.rank, n."mojoId", n.last_contact_at,
      ${groupChipsSql('n.id')} AS groups, nt.text AS next_text, nt."dueDate" AS next_due_date
    FROM unnest(${columnIds}::text[]) AS g(gid)
    LEFT JOIN counts ON counts.group_id = g.gid
    LEFT JOIN numbered n ON n.group_id = g.gid AND n.pos > ${offset} AND n.pos <= ${offset + BOARD_PAGE_SIZE}
    ${nextTaskJoin('n.id')}
    ORDER BY g.gid, n.pos`
  const columns: PipelineColumn[] = columnGroups.map((group) => {
    const mine = cards.filter((c) => c.group_id === group.id)
    const count = mine[0]?.col_count ?? 0
    const list: PipelineCard[] = mine.filter((c) => c.id !== null).map((c) => {
      const chips = c.groups ?? []
      return {
        leadId: c.id as string,
        displayName: c.displayName,
        address: c.address,
        value: null,
        bestBuyer: bestOf(c.id as string, c.mojoId),
        lastContactAt: c.last_contact_at?.toISOString() ?? null,
        nextTask: nextTask(c),
        inGroupSince: c.added_at.toISOString(),
        groups: chips,
        alsoIn: chips.filter((g) => g.id !== group.id).map((g) => ({ id: g.id, name: g.name })),
        rank: c.rank,
      }
    })
    return { group, count, cards: list, hasMore: offset + list.length < count, page }
  })
  return { view: 'board', columns, filterOptions }
}

async function loadFilterOptions(organizationId: string, db: PrismaClient): Promise<PipelineFilterOptions> {
  const rows = await db.$queryRaw<{ t: string }[]>`
    SELECT DISTINCT btrim(regexp_replace(v."valueText", ${'\\s+'}, ' ', 'g')) AS t
    FROM "CustomFieldValue" v JOIN "CustomFieldDefinition" d ON d.id = v."definitionId"
    WHERE d."organizationId" = ${organizationId} AND d."objectType" = 'lead' AND d.name = ${FIELD.propertyType}
      AND btrim(coalesce(v."valueText", '')) <> ''
    LIMIT 500`
  return {
    propertyTypes: rows.map((r) => r.t).sort((a, b) => a.localeCompare(b)),
    neighborhoods: [...NEIGHBORHOODS],
    boroughs: [...BOROUGHS],
  }
}
