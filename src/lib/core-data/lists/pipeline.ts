// Brief 45 — the Pipeline page's data [brief §5.6; CONTRACT §6b]: one column
// per group (board) or one row per lead (table). Ryan asked for a customizable
// page with filters [Ryan, 2026-10-18]; which filters is the planner's design
// [brief §5.6]. Organization only: nothing here contacts anyone.
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
//   valueMin/Max    our value estimate (Brief 44, the lead page's), in whole
//                   dollars, both ends included; people without one are left
//                   out (Brief 45 PR G; the page offers it once the org has
//                   estimates, filterOptions.hasValues)
// Cards and rows carry that estimate too, for Ryan's own screen only [Ryan,
// 2026-10-17: our value estimates never reach anything a buyer or homeowner
// sees]. Sensitive life details are never filters [engineering precaution;
// fair-housing and NY human-rights law].
import { z } from 'zod'
import { Prisma, type PrismaClient } from '@prisma/client'
import { DateTime } from 'luxon'
import { prisma } from '@/lib/prisma'
import {
  BOARD_PAGE_SIZE, BOROUGHS, MAX_PAGE, PAGE_SIZE, PIPELINE_SORT_KEYS, PIPELINE_VIEWS,
  type GroupChipDTO, type PipelineCard, type PipelineColumn, type PipelineFilterOptions,
  type PipelineFilters, type PipelineQuery, type PipelineResult, type PipelineRow, type PipelineSortKey, type SortDir,
} from './types'
import { HOT_MIN_FIT, STRONG_BUYER_MIN_FIT, WARM_MIN_FIT, canonicalDollars } from './rules'
import { NEIGHBORHOODS, cleanText } from './geo'
import { listGroups } from './groups'
import {
  FIELD, NY, attemptsOf, badRequest, bestBuyerCtes, bestBuyerDTO, bestBuyerJoins, boroughSql, cleanSql, defsCte, fieldValue,
  groupChipsSql, hasValuesSql, leadInOrg, likePattern, neighborhoodSql, ourValueCtes, ourValueDTO, ourValueJoin, unitsSql, utc, zipOf,
} from './sql'

// ─── The filters, as the query string spells them ────────────────────────────

const UNITS = ['1', '2', '3', '4', '5+'] as const
const TIERS = ['hot', 'warm', 'possible', 'none'] as const
const LAST_CONTACT = ['never', 'over7', 'over30', 'over60', 'over90'] as const
const TASK_DUE = ['today', 'week', 'overdue'] as const
const TIME_IN_GROUP = ['30', '60', '90'] as const
const id = z.string().min(1).max(64)
// Whole dollars, written one way (rules.ts canonicalDollars).
const dollars = z.string().refine((v) => canonicalDollars(v) === v, 'Whole dollars from 0 to 1,000,000,000.')

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
  valueMin: dollars.optional(),
  valueMax: dollars.optional(),
}).refine((f) => f.valueMin === undefined || f.valueMax === undefined || Number(f.valueMin) <= Number(f.valueMax), {
  message: 'The value range is backwards: the lowest value is above the highest.',
})

/** One end of the value range from the query string, written one way; 400 in plain English otherwise. */
function valueEnd(raw: string | undefined, which: 'lowest' | 'highest'): string | undefined {
  if (raw === undefined) return undefined
  const dollars = canonicalDollars(raw)
  if (dollars === null) throw badRequest(`The ${which} value must be whole dollars from 0 to 1,000,000,000 (not ${raw.slice(0, 40)}).`)
  return dollars
}

/** The value range is on: our estimate is then read for every candidate (and people without one are left out). */
const valueFilterOn = (f: PipelineFilters) => f.valueMin !== undefined || f.valueMax !== undefined

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
  // Brief 45 PR G: the range is valueMin / valueMax; a bare `value` is refused
  // (never guessed at) rather than ignored, so a hand-made link can't quietly
  // show everyone.
  if (sp.has('value')) throw badRequest('Filter by value with valueMin and valueMax, in whole dollars.')
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
  const valueMin = valueEnd(get('valueMin'), 'lowest')
  const valueMax = valueEnd(get('valueMax'), 'highest')
  // Backwards is refused, not swapped: the page never writes it (the Filters
  // panel says so as you type), so a backwards link is a mistake to show.
  if (valueMin !== undefined && valueMax !== undefined && Number(valueMin) > Number(valueMax)) {
    throw badRequest('The value range is backwards: the lowest value is above the highest.')
  }
  set('valueMin', valueMin)
  set('valueMax', valueMax)
  set('q', get('q')?.slice(0, 200)) // like list pages' search box
  const page = Number.parseInt(get('page') ?? '1', 10)
  return {
    view: oneOf(get('view'), PIPELINE_VIEWS, 'view') ?? 'board',
    groups: get('groups')?.split(',').map((g) => g.trim()).filter(Boolean),
    filters,
    column: get('column'),
    // Brief 45 PR D review: a 20-digit page overflowed the OFFSET (500); like
    // any other page value it doesn't understand, the API reads it as page 1.
    page: Number.isSafeInteger(page) && page >= 1 && page <= MAX_PAGE ? page : 1,
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
// lead) → info (per lead: what the filters read) → with the value range on,
// our_value for every candidate (otherwise each query reads it for the shown
// page only, after paging).
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
  )${valueFilterOn(ctx.filters) ? Prisma.sql`, ${ourValueCtes(ctx.org, 'info')}` : Prisma.empty}`
}

/** our_value for the page or cards shown (`scope`), unless ctes() already read it for every candidate. */
const shownValues = (ctx: Ctx, scope: string) => (valueFilterOn(ctx.filters) ? Prisma.empty : Prisma.sql`, ${ourValueCtes(ctx.org, scope)}`)

// Not an index condition (see leadInOrg): the lead's own activity index is the
// cheap way in; ANDing it with the org's index scans every org activity per lead.
const activityInOrg = (org: string) => Prisma.sql`(a."organizationId" = ${org}) IS TRUE`

/** Conditions on one lead (alias i). */
function leadConditions(ctx: Ctx): Prisma.Sql[] {
  const f = ctx.filters
  const conds: Prisma.Sql[] = []
  const q = f.q?.trim().slice(0, 200)
  if (q) {
    const p = likePattern(q)
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
  if (valueFilterOn(f)) {
    // Both ends included; no estimate, no match (our_value has no row).
    const bounds: Prisma.Sql[] = []
    for (const [raw, op] of [[f.valueMin, '>='], [f.valueMax, '<=']] as const) {
      if (raw === undefined) continue
      const dollars = canonicalDollars(raw)
      if (dollars === null) throw badRequest('The value range must be whole dollars from 0 to 1,000,000,000.')
      bounds.push(Prisma.sql`ov.value ${Prisma.raw(op)} ${Number(dollars)}::float8`)
    }
    conds.push(Prisma.sql`EXISTS (SELECT 1 FROM our_value ov WHERE ov.lead_id = i.id AND ${Prisma.join(bounds, ' AND ')})`)
  }
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
  best_buyer: unknown
  our_value: number | null
  our_low: number | null
  our_high: number | null
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
  const [groups, filterOptions] = await Promise.all([listGroups(organizationId, db), loadFilterOptions(organizationId, db)])
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
      page AS (SELECT * FROM f ORDER BY ${sortSql('f', sort, dir)} LIMIT ${PAGE_SIZE} OFFSET ${(page - 1) * PAGE_SIZE}),
      ${bestBuyerCtes(organizationId, 'page')}${shownValues(ctx, 'page')}
      SELECT t.total, p.id, p."displayName", p."primaryAddressSummary" AS address, p.in_group_since, p.rank, p."mojoId",
        p."priorityScore", p."topMatchFit", p.last_contact_at, p.next_due,
        ${groupChipsSql('p.id')} AS groups, nt.text AS next_text, nt."dueDate" AS next_due_date,
        COALESCE(bl.best, bm.best) AS best_buyer, ov.value AS our_value, ov.low AS our_low, ov.high AS our_high
      FROM (SELECT count(*)::int AS total FROM f) t
      LEFT JOIN page p ON true
      ${nextTaskJoin('p.id')}
      ${bestBuyerJoins('p')}
      ${ourValueJoin('p')}
      ORDER BY ${sortSql('p', sort, dir)}`
    const out: PipelineRow[] = rows.filter((r) => r.id !== null).map((r) => ({
      leadId: r.id as string,
      displayName: r.displayName,
      address: r.address,
      value: ourValueDTO(r.our_value, r.our_low, r.our_high),
      bestBuyer: bestBuyerDTO(r.best_buyer),
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
    counts AS (SELECT group_id, count(*)::int AS n FROM f GROUP BY group_id),
    shown_cards AS (SELECT * FROM numbered WHERE pos > ${offset} AND pos <= ${offset + BOARD_PAGE_SIZE}),
    ${bestBuyerCtes(organizationId, 'shown_cards')}${shownValues(ctx, 'shown_cards')}
    SELECT g.gid AS group_id, COALESCE(counts.n, 0) AS col_count, n.id, n."displayName", n."primaryAddressSummary" AS address,
      n.added_at, n.rank, n."mojoId", n.last_contact_at,
      ${groupChipsSql('n.id')} AS groups, nt.text AS next_text, nt."dueDate" AS next_due_date,
      COALESCE(bl.best, bm.best) AS best_buyer, ov.value AS our_value, ov.low AS our_low, ov.high AS our_high
    FROM unnest(${columnIds}::text[]) AS g(gid)
    LEFT JOIN counts ON counts.group_id = g.gid
    LEFT JOIN shown_cards n ON n.group_id = g.gid
    ${nextTaskJoin('n.id')}
    ${bestBuyerJoins('n')}
    ${ourValueJoin('n')}
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
        value: ourValueDTO(c.our_value, c.our_low, c.our_high),
        bestBuyer: bestBuyerDTO(c.best_buyer),
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

// One query: the property types in the org, and (Brief 45 PR G) whether
// DealFlow's estimates are in yet, which decides if the value range is offered.
async function loadFilterOptions(organizationId: string, db: PrismaClient): Promise<PipelineFilterOptions> {
  const [row] = await db.$queryRaw<{ types: string[]; hasValues: boolean }[]>`
    SELECT ARRAY(
        SELECT DISTINCT btrim(regexp_replace(v."valueText", ${'\\s+'}, ' ', 'g'))
        FROM "CustomFieldValue" v JOIN "CustomFieldDefinition" d ON d.id = v."definitionId"
        WHERE d."organizationId" = ${organizationId} AND d."objectType" = 'lead' AND d.name = ${FIELD.propertyType}
          AND btrim(coalesce(v."valueText", '')) <> ''
        LIMIT 500) AS types,
      ${hasValuesSql(organizationId)} AS "hasValues"`
  return {
    propertyTypes: [...(row?.types ?? [])].sort((a, b) => a.localeCompare(b)),
    neighborhoods: [...NEIGHBORHOODS],
    boroughs: [...BOROUGHS],
    hasValues: row?.hasValues === true,
  }
}
