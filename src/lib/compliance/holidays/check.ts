import { prisma as defaultPrisma, resolveDb } from '@/lib/compliance/db'
import { statesForTimezone } from '@/lib/compliance/timezone/tzStateMap'
import { holidaySetCache, holidayCacheKey } from '@/lib/compliance/caches'

const DAY_MS = 24 * 60 * 60 * 1000
const STALE_FAIL_CLOSED_DAYS = 40 // >40d stale => cannot trust table => fail-closed

export type HolidayReason = 'holiday_federal' | 'holiday_state' | 'holiday_table_stale'

export interface HolidayResult {
  blocked: boolean
  reason?: HolidayReason
  detail?: { name?: string; state?: string }
}

export interface HolidayRow {
  scope: string // 'federal' | 'state:XX'
  name: string
}

// Minimal structural Prisma surface — lets tests inject a fake without a DB.
export interface HolidayDb {
  holidaySuppressionDate: {
    findMany: (args: any) => Promise<HolidayRow[]>
    findFirst: (args: any) => Promise<{ createdAt: Date } | null>
  }
}

// Convert a local YYYY-MM-DD to the UTC-midnight Date used to store/query the
// `@db.Date` column. The refresh worker writes with the same convention, so
// equality matches.
export function localDateToUtcMidnight(yyyyMmDd: string): Date {
  return new Date(`${yyyyMmDd}T00:00:00.000Z`)
}

// PURE decision core. Federal blocks everyone; state-scope blocks only the
// contact's applicable state(s). A stale table (>40d) fails-closed regardless
// of contents — we cannot certify today is not a holiday.
export function evaluateHoliday(input: {
  rows: HolidayRow[]
  freshDays: number
  applicableStates: readonly string[]
}): HolidayResult {
  if (input.freshDays > STALE_FAIL_CLOSED_DAYS) {
    return { blocked: true, reason: 'holiday_table_stale' }
  }
  const federal = input.rows.find((r) => r.scope === 'federal')
  if (federal) {
    return { blocked: true, reason: 'holiday_federal', detail: { name: federal.name } }
  }
  const applicable = new Set(input.applicableStates.map((s) => `state:${s}`))
  const stateHit = input.rows.find((r) => applicable.has(r.scope))
  if (stateHit) {
    const state = stateHit.scope.slice('state:'.length)
    return { blocked: true, reason: 'holiday_state', detail: { state, name: stateHit.name } }
  }
  return { blocked: false }
}

// Days since the newest HolidaySuppressionDate row was written. No rows => 999
// (treated as maximally stale => fail-closed). Also surfaced by /health.
export async function holidayTableFreshDays(
  orgId: string,
  db: HolidayDb = defaultPrisma as unknown as HolidayDb,
  now: Date = new Date()
): Promise<number> {
  const newest = await db.holidaySuppressionDate.findFirst({
    where: { organizationId: orgId },
    orderBy: { createdAt: 'desc' },
    select: { createdAt: true },
  })
  if (!newest) return 999
  return Math.floor((now.getTime() - newest.createdAt.getTime()) / DAY_MS)
}

// Thin reader + evaluator. `applicableStates` is [contactState] when the state
// is known, else the whole tz bucket (broader, fail-closed over-block). Pass a
// precomputed `freshDays` in a batch to avoid re-querying per phone.
export async function checkHoliday(
  input: {
    orgId: string
    localDate: string // YYYY-MM-DD (local)
    contactState: string | null
    contactTimezone: string
  },
  opts: { db?: HolidayDb; freshDays?: number; useCache?: boolean; now?: Date } = {}
): Promise<HolidayResult> {
  const db = resolveDb<HolidayDb>(opts.db)
  const applicableStates = input.contactState
    ? [input.contactState]
    : [...statesForTimezone(input.contactTimezone)]

  const stateKey = input.contactState ?? input.contactTimezone
  const cacheKey = holidayCacheKey(input.orgId, input.localDate, stateKey)
  if (opts.useCache) {
    const hit = holidaySetCache.get(cacheKey)
    if (hit) return hit.value as HolidayResult
  }

  const scopes = ['federal', ...applicableStates.map((s) => `state:${s}`)]
  const rows = await db.holidaySuppressionDate.findMany({
    where: {
      organizationId: input.orgId,
      date: localDateToUtcMidnight(input.localDate),
      scope: { in: scopes },
    },
    select: { scope: true, name: true },
  })
  const freshDays = opts.freshDays ?? (await holidayTableFreshDays(input.orgId, db, opts.now))
  const result = evaluateHoliday({ rows, freshDays, applicableStates })

  if (opts.useCache) holidaySetCache.set(cacheKey, { value: result })
  return result
}
