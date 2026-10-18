// Brief 45 — every list, and All leads, always shown ranked [Ryan, 2026-10-18].
// The order is the planner's design [brief §5.5], computed when the list is
// read and never stored:
//   1. DealFlow priority, highest first, unscored last;
//   2. then best buyer fit, highest first;
//   3. then fewest call attempts (Mojo's "Call Attempts"; missing = 0);
//   4. then who was added to the CRM first;
//   5. then id, so the order never wobbles.
// priorityScore changes only at the morning DealFlow sync (and when new
// people are scored), so every list re-ranks each morning by itself.
//
// The rank is row_number() over the WHOLE list; search and filters apply
// after it, so each person's number is their place in the full list
// [brief §5.4]. A page is 100 rows in 2 queries. Display-only: no
// phone numbers or emails are selected, and nothing here calls, texts or
// emails anyone.
import { Prisma, type PrismaClient } from '@prisma/client'
import { DateTime } from 'luxon'
import { prisma } from '@/lib/prisma'
import { dialingEnabled } from '@/lib/telephony/dialingSwitch'
import { reasonText, timezoneLabel } from '@/lib/core-data/dealflow-sync/labels'
import { rankStateOf, STRONG_BUYER_MIN_FIT } from './rules'
import {
  CALLING_OFF_REASON, IDS_CAP, MAX_PAGE, PAGE_SIZE,
  type CallingWindowDTO, type GroupChipDTO, type MemberFilters, type RankedPage, type RankedRow,
} from './types'
import {
  NY, attemptsOf, bestBuyerCtes, bestBuyerDTO, bestBuyerJoins, boroughSql, defsCte, fieldValue, groupChipsSql, leadInOrg,
  likePattern, notFound, rankingTimesSql, utc, zipOf,
} from './sql'
import { fileStem, toCsv } from './csv'

export interface RankedOptions {
  page?: number
  filters?: MemberFilters
  /** Defaults to dialingEnabled() (read only). Tests pass it rather than touch the switch. */
  callingOn?: boolean
  now?: Date
}

interface Ctx {
  org: string
  listId: string | null
  filters: MemberFilters
  callingOn: boolean
  day: { start: Date; end: Date; date: string }
}

function context(organizationId: string, listId: string | null, opts: RankedOptions): Ctx {
  const start = DateTime.fromJSDate(opts.now ?? new Date()).setZone(NY).startOf('day')
  return {
    org: organizationId,
    listId,
    filters: opts.filters ?? {},
    callingOn: opts.callingOn ?? dialingEnabled(),
    day: { start: start.toJSDate(), end: start.plus({ days: 1 }).toJSDate(), date: start.toISODate()! },
  }
}

// "Called today" [brief §5.1 rule 3]: a call today (New York day), or Mojo's
// "Last Dial Date" is today (a New York wall-clock date). Only used while
// calling is on; otherwise it is false for everyone.
function calledTodaySql(ctx: Ctx, alias: string): Prisma.Sql {
  const lead = Prisma.raw(`${alias}.id`)
  return Prisma.sql`(EXISTS (SELECT 1 FROM "Call" c WHERE c."organizationId" = ${ctx.org} AND c."leadId" = ${lead}
      AND c."activityAt" >= ${utc(ctx.day.start)} AND c."activityAt" < ${utc(ctx.day.end)})
    OR EXISTS (SELECT 1 FROM "CustomFieldValue" v WHERE v."definitionId" = (SELECT last_dial FROM defs)
      AND v."objectId" = ${lead} AND v."valueDate"::date = ${ctx.day.date}::date))`
}

function whereSql(ctx: Ctx): Prisma.Sql {
  const f = ctx.filters
  const conds: Prisma.Sql[] = []
  const q = f.q?.trim().slice(0, 200)
  if (q) {
    const p = likePattern(q)
    conds.push(Prisma.sql`(r."displayName" ILIKE ${p} OR r."primaryAddressSummary" ILIKE ${p})`)
  }
  if (f.group === 'none') {
    conds.push(Prisma.sql`NOT EXISTS (SELECT 1 FROM "LeadGroupMembership" gm WHERE gm."leadId" = r.id)`)
  } else if (f.group) {
    conds.push(Prisma.sql`EXISTS (SELECT 1 FROM "LeadGroupMembership" gm JOIN "LeadGroup" g ON g.id = gm."groupId"
      WHERE gm."leadId" = r.id AND gm."groupId" = ${f.group} AND g."organizationId" = ${ctx.org})`)
  }
  if (f.strongBuyer) conds.push(Prisma.sql`r."topMatchFit" >= ${STRONG_BUYER_MIN_FIT}`)
  // Not filterable while calling is off: the UI greys it out with the reason.
  if (f.calledToday && ctx.callingOn) conds.push(calledTodaySql(ctx, 'r'))
  if (f.borough) conds.push(Prisma.sql`${boroughSql(Prisma.raw('r.zip_text'), Prisma.raw('r.city_text'))} = ${f.borough}`)
  return conds.length ? Prisma.join(conds, ' AND ') : Prisma.sql`TRUE`
}

// defs → base (the list's members, or every lead) → ranked (row_number over
// all of them) → filtered.
function rankedCtes(ctx: Ctx): Prisma.Sql {
  const geo = Boolean(ctx.filters.borough)
  const source = ctx.listId
    ? Prisma.sql`FROM "ListMembership" m JOIN "Lead" l ON l.id = m."leadId"
      WHERE m."listId" = ${ctx.listId} AND ${leadInOrg('l', ctx.org)}`
    : Prisma.sql`FROM "Lead" l WHERE l."organizationId" = ${ctx.org}`
  return Prisma.sql`WITH ${defsCte(ctx.org)},
  base AS (
    SELECT l.id, l."displayName", l."primaryAddressSummary", l."priorityScore", l."topMatchFit", l."createdAt",
      l."mojoId", l."matchReason", l."dealflowSignalSyncedAt", l.timezone AS lead_tz,
      ${ctx.listId ? Prisma.sql`m."addedAt"` : Prisma.sql`NULL::timestamp(3)`} AS added_at,
      ${attemptsOf('l.id')} AS attempts
      ${geo ? Prisma.sql`, ${zipOf('l.id')} AS zip_text, ${fieldValue('city', 'valueText', 'l.id')} AS city_text` : Prisma.empty}
    ${source}
  ),
  ranked AS (
    SELECT base.*, (row_number() OVER (ORDER BY "priorityScore" DESC NULLS LAST, "topMatchFit" DESC NULLS LAST,
      attempts ASC, "createdAt" ASC, id COLLATE "C" ASC))::int AS rank
    FROM base
  ),
  filtered AS (SELECT * FROM ranked r WHERE ${whereSql(ctx)})`
}

interface RowSql {
  total: number
  id: string | null
  displayName: string
  address: string | null
  priorityScore: number | null
  topMatchFit: number | null
  createdAt: Date
  mojoId: string | null
  matchReason: string | null
  dealflowSignalSyncedAt: Date | null
  added_at: Date | null
  attempts: number
  rank: number
  groups: GroupChipDTO[]
  last_result: string | null
  timezone: string | null
  called_today: boolean
  best_buyer: unknown
}

function rowsQuery(ctx: Ctx, limit: number, offset: number): Prisma.Sql {
  return Prisma.sql`${rankedCtes(ctx)},
  page AS (SELECT * FROM filtered ORDER BY rank LIMIT ${limit} OFFSET ${offset}),
  ${bestBuyerCtes(ctx.org, 'page')}
  SELECT t.total, p.id, p."displayName", p."primaryAddressSummary" AS address, p."priorityScore", p."topMatchFit",
    p."createdAt", p."mojoId", p."matchReason", p."dealflowSignalSyncedAt", p.added_at, p.attempts, p.rank,
    ${groupChipsSql('p.id')} AS groups,
    ${fieldValue('last_result', 'valueText', 'p.id')} AS last_result,
    COALESCE((SELECT c.timezone FROM "Contact" c WHERE c."leadId" = p.id ORDER BY c."createdAt", c.id COLLATE "C" LIMIT 1), p.lead_tz) AS timezone,
    ${ctx.callingOn ? calledTodaySql(ctx, 'p') : Prisma.sql`false`} AS called_today,
    COALESCE(bl.best, bm.best) AS best_buyer
  FROM (SELECT count(*)::int AS total FROM filtered) t
  LEFT JOIN page p ON true
  ${bestBuyerJoins('p')}
  ORDER BY p.rank`
}

interface MetaSql {
  id?: string
  name?: string
  folderId?: string | null
  source?: string
  sortOrder?: number
  archivedAt?: Date | null
  createdAt?: Date
  folderName?: string | null
  uploadedAt?: Date | null
  memberCount: number
  rankedAt: Date | null
  rankingCutoff: Date | null
  windows: { timezone: string; earliestHour: number; latestHour: number; allowedDaysOfWeek: number[]; confirmed: boolean }[]
}

function windowsSql(org: string): Prisma.Sql {
  return Prisma.sql`(SELECT COALESCE(json_agg(json_build_object('timezone', w.timezone, 'earliestHour', w."earliestHour",
      'latestHour', w."latestHour", 'allowedDaysOfWeek', w."allowedDaysOfWeek", 'confirmed', w."policyConfirmedBy" IS NOT NULL)), '[]'::json)
    FROM "CallingWindowConfig" w WHERE w."organizationId" = ${org})`
}

function metaQuery(ctx: Ctx): Prisma.Sql {
  if (!ctx.listId) {
    return Prisma.sql`SELECT (SELECT count(*)::int FROM "Lead" WHERE "organizationId" = ${ctx.org}) AS "memberCount",
      ${rankingTimesSql(ctx.org)}, ${windowsSql(ctx.org)} AS windows`
  }
  return Prisma.sql`SELECT cl.id, cl.name, cl."folderId", cl.source, cl."sortOrder", cl."archivedAt", cl."createdAt",
      f.name AS "folderName", ib."createdAt" AS "uploadedAt",
      (SELECT count(*)::int FROM "ListMembership" m WHERE m."listId" = cl.id) AS "memberCount",
      ${rankingTimesSql(ctx.org)}, ${windowsSql(ctx.org)} AS windows
    FROM "CallList" cl
    LEFT JOIN "Folder" f ON f.id = cl."folderId"
    LEFT JOIN "ImportBatch" ib ON cl.source LIKE 'upload:%' AND ib.id = substr(cl.source, 8) AND ib."organizationId" = cl."organizationId"
    WHERE cl.id = ${ctx.listId} AND cl."organizationId" = ${ctx.org}`
}

// The code default (schema defaults) for a zone with no CallingWindowConfig,
// never confirmed. The UI says "inside / outside calling hours (not confirmed
// yet)", never "OK to call" [engineering precaution: no compliance claim].
const DEFAULT_WINDOW: CallingWindowDTO = { earliestHour: 9, latestHour: 20, allowedDaysOfWeek: [1, 2, 3, 4, 5], confirmed: false }

async function load(db: PrismaClient, ctx: Ctx, limit: number, offset: number) {
  const [meta, rows] = await Promise.all([
    db.$queryRaw<MetaSql[]>(metaQuery(ctx)),
    db.$queryRaw<RowSql[]>(rowsQuery(ctx, limit, offset)),
  ])
  if (meta.length === 0) throw notFound('List')
  return { meta: meta[0], rows }
}

function toRows(rows: RowSql[], meta: MetaSql): RankedRow[] {
  return rows
    .filter((r) => r.id !== null)
    .map((r) => {
      const { rankState, notRankedReason } = rankStateOf(r, meta.rankingCutoff)
      return {
        rank: r.rank,
        leadId: r.id as string,
        displayName: r.displayName,
        address: r.address,
        priorityScore: r.priorityScore,
        topMatchFit: r.topMatchFit,
        rankState,
        notRankedReason,
        whyNow: reasonText(r.matchReason),
        bestBuyer: bestBuyerDTO(r.best_buyer),
        groups: r.groups ?? [],
        attempts: Number(r.attempts),
        lastResult: r.last_result,
        timezone: r.timezone,
        calledToday: r.called_today === true,
        addedAt: r.added_at?.toISOString() ?? null,
      }
    })
}

// 1 to MAX_PAGE, else 1: a bigger page would overflow the database's OFFSET [engineering precaution].
const pageNumber = (p: number | undefined) => (Number.isSafeInteger(p) && (p as number) >= 1 && (p as number) <= MAX_PAGE ? (p as number) : 1)

/** One page (100 rows) of a list (listId) or of All leads (null), in rank order. */
export async function getRankedPage(
  organizationId: string,
  listId: string | null,
  opts: RankedOptions = {},
  db: PrismaClient = prisma,
): Promise<RankedPage> {
  const ctx = context(organizationId, listId, opts)
  const page = pageNumber(opts.page)
  const { meta, rows } = await load(db, ctx, PAGE_SIZE, (page - 1) * PAGE_SIZE)
  const ranked = toRows(rows, meta)

  const callingWindows: Record<string, CallingWindowDTO> = {}
  for (const w of meta.windows) {
    callingWindows[w.timezone] = { earliestHour: w.earliestHour, latestHour: w.latestHour, allowedDaysOfWeek: w.allowedDaysOfWeek, confirmed: w.confirmed }
  }
  for (const r of ranked) if (r.timezone && !callingWindows[r.timezone]) callingWindows[r.timezone] = { ...DEFAULT_WINDOW }

  return {
    list: listId
      ? {
          id: meta.id!, name: meta.name!, folderId: meta.folderId ?? null, source: meta.source!, sortOrder: meta.sortOrder!,
          archivedAt: meta.archivedAt?.toISOString() ?? null, memberCount: meta.memberCount, createdAt: meta.createdAt!.toISOString(),
          ...(meta.uploadedAt ? { uploadedAt: meta.uploadedAt.toISOString() } : {}),
          folderName: meta.folderName ?? null,
        }
      : null,
    total: rows[0]?.total ?? 0,
    memberCount: meta.memberCount,
    page,
    pageSize: PAGE_SIZE,
    rankedAt: meta.rankedAt?.toISOString() ?? null,
    callingOffReason: ctx.callingOn ? null : CALLING_OFF_REASON,
    callingWindows,
    rows: ranked,
  }
}

/** Every matching lead id in rank order (for "select all"), capped at 25,000. */
export async function getRankedIds(
  organizationId: string,
  listId: string | null,
  opts: Omit<RankedOptions, 'page'> = {},
  db: PrismaClient = prisma,
): Promise<string[]> {
  const ctx = context(organizationId, listId, opts)
  if (listId) {
    const list = await db.callList.findFirst({ where: { id: listId, organizationId }, select: { id: true } })
    if (!list) throw notFound('List')
  }
  const rows = await db.$queryRaw<{ id: string }[]>`${rankedCtes(ctx)} SELECT id FROM filtered ORDER BY rank LIMIT ${IDS_CAP}`
  return rows.map((r) => r.id)
}

export const EXPORT_COLUMNS = [
  'Rank', 'Name', 'Address', 'Priority', 'Match fit', 'Why now', 'Best buyer', 'Groups', 'Attempts', 'Last result', 'Timezone',
] as const

/**
 * The list (or All leads) as CSV, in rank order, with the same filters. No
 * phone numbers or emails, the same columns policy as the Leads export
 * [engineering precaution]. At most 25,000 rows (truncated says so).
 */
export async function exportRankedCsv(
  organizationId: string,
  listId: string | null,
  opts: Omit<RankedOptions, 'page'> = {},
  db: PrismaClient = prisma,
): Promise<{ filename: string; csv: string; truncated: boolean }> {
  const ctx = context(organizationId, listId, opts)
  const { meta, rows } = await load(db, ctx, IDS_CAP, 0)
  const ranked = toRows(rows, meta)
  const csv = toCsv(EXPORT_COLUMNS, ranked.map((r) => [
    r.rank, r.displayName, r.address, r.priorityScore, r.topMatchFit, r.whyNow, r.bestBuyer?.name ?? null,
    r.groups.map((g) => g.name).join('; '), r.attempts, r.lastResult, timezoneLabel(r.timezone),
  ]))
  const stem = listId ? fileStem(meta.name ?? 'list') : 'All-leads'
  return { filename: `${stem}-ranked-${ctx.day.date}.csv`, csv, truncated: (rows[0]?.total ?? 0) > IDS_CAP }
}
