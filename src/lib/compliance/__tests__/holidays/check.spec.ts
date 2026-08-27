import { describe, it, expect, beforeEach } from 'vitest'
import {
  evaluateHoliday,
  checkHoliday,
  holidayTableFreshDays,
  localDateToUtcMidnight,
} from '@/lib/compliance/holidays/check'
import { resetAllCaches } from '@/lib/compliance/caches'

beforeEach(() => resetAllCaches())

describe('evaluateHoliday (pure)', () => {
  it('federal holiday blocks everyone', () => {
    const r = evaluateHoliday({ rows: [{ scope: 'federal', name: 'Christmas Day' }], freshDays: 1, applicableStates: [] })
    expect(r).toEqual({ blocked: true, reason: 'holiday_federal', detail: { name: 'Christmas Day' } })
  })

  it('state holiday blocks only when the state is applicable', () => {
    const rows = [{ scope: 'state:MA', name: "Patriots' Day" }]
    expect(evaluateHoliday({ rows, freshDays: 1, applicableStates: ['MA'] })).toEqual({
      blocked: true,
      reason: 'holiday_state',
      detail: { state: 'MA', name: "Patriots' Day" },
    })
    expect(evaluateHoliday({ rows, freshDays: 1, applicableStates: ['NY'] })).toEqual({ blocked: false })
  })

  it('federal takes precedence over a state hit on the same query', () => {
    const rows = [
      { scope: 'state:CA', name: 'César Chávez Day' },
      { scope: 'federal', name: 'Independence Day' },
    ]
    expect(evaluateHoliday({ rows, freshDays: 1, applicableStates: ['CA'] }).reason).toBe('holiday_federal')
  })

  it('stale table (>40d) fails-closed regardless of contents', () => {
    const r = evaluateHoliday({ rows: [{ scope: 'federal', name: 'X' }], freshDays: 41, applicableStates: [] })
    expect(r).toEqual({ blocked: true, reason: 'holiday_table_stale' })
  })

  it('no matching rows => not blocked', () => {
    expect(evaluateHoliday({ rows: [], freshDays: 0, applicableStates: ['NY'] })).toEqual({ blocked: false })
  })
})

describe('holidayTableFreshDays', () => {
  it('returns 999 when the table is empty', async () => {
    const db = { holidaySuppressionDate: { findFirst: async () => null, findMany: async () => [] } }
    expect(await holidayTableFreshDays('o', db as any)).toBe(999)
  })

  it('computes whole days since newest createdAt', async () => {
    const now = new Date('2027-02-10T00:00:00Z')
    const db = {
      holidaySuppressionDate: {
        findFirst: async () => ({ createdAt: new Date('2027-02-01T00:00:00Z') }),
        findMany: async () => [],
      },
    }
    expect(await holidayTableFreshDays('o', db as any, now)).toBe(9)
  })
})

describe('checkHoliday (reader + evaluator)', () => {
  const makeDb = (rows: Array<{ scope: string; name: string }>, createdAt: Date | null = new Date()) => ({
    holidaySuppressionDate: {
      findMany: async (args: any) => {
        // Honor the scope filter so applicable-state logic is exercised.
        const scopes: string[] = args.where.scope.in
        return rows.filter((r) => scopes.includes(r.scope))
      },
      findFirst: async () => (createdAt ? { createdAt } : null),
    },
  })

  it('federal blocks a NY contact', async () => {
    const db = makeDb([{ scope: 'federal', name: 'Thanksgiving Day' }])
    const r = await checkHoliday(
      { orgId: 'o', localDate: '2027-11-25', contactState: 'NY', contactTimezone: 'America/New_York' },
      { db: db as any, freshDays: 1 }
    )
    expect(r.reason).toBe('holiday_federal')
  })

  it('Patriots Day (MA) blocks an MA contact but not an NY contact', async () => {
    const db = makeDb([{ scope: 'state:MA', name: "Patriots' Day" }])
    const ma = await checkHoliday(
      { orgId: 'o', localDate: '2027-04-19', contactState: 'MA', contactTimezone: 'America/New_York' },
      { db: db as any, freshDays: 1 }
    )
    expect(ma.reason).toBe('holiday_state')
    const ny = await checkHoliday(
      { orgId: 'o', localDate: '2027-04-19', contactState: 'NY', contactTimezone: 'America/New_York' },
      { db: db as any, freshDays: 1 }
    )
    expect(ny.blocked).toBe(false)
  })

  it('null contactState expands to the whole tz bucket (over-block, fail-closed)', async () => {
    const db = makeDb([{ scope: 'state:MA', name: "Patriots' Day" }])
    // America/New_York bucket includes MA, so a null-state Eastern contact is blocked.
    const r = await checkHoliday(
      { orgId: 'o', localDate: '2027-04-19', contactState: null, contactTimezone: 'America/New_York' },
      { db: db as any, freshDays: 1 }
    )
    expect(r.reason).toBe('holiday_state')
    expect(r.detail?.state).toBe('MA')
  })

  it('caches the result under (org, localDate, state) when useCache', async () => {
    let calls = 0
    const db = {
      holidaySuppressionDate: {
        findMany: async () => {
          calls++
          return [{ scope: 'federal', name: 'X' }]
        },
        findFirst: async () => ({ createdAt: new Date() }),
      },
    }
    const args = { orgId: 'o', localDate: '2027-07-04', contactState: 'NY', contactTimezone: 'America/New_York' }
    await checkHoliday(args, { db: db as any, freshDays: 1, useCache: true })
    await checkHoliday(args, { db: db as any, freshDays: 1, useCache: true })
    expect(calls).toBe(1) // second call served from cache
  })

  it('computes freshDays internally when not provided', async () => {
    const now = new Date('2027-02-10T00:00:00Z')
    const db = {
      holidaySuppressionDate: {
        findMany: async () => [{ scope: 'federal', name: 'X' }],
        findFirst: async () => ({ createdAt: new Date('2026-01-01T00:00:00Z') }), // >40d stale
      },
    }
    const r = await checkHoliday(
      { orgId: 'o', localDate: '2027-02-10', contactState: 'NY', contactTimezone: 'America/New_York' },
      { db: db as any, now } // no freshDays -> computed -> stale
    )
    expect(r.reason).toBe('holiday_table_stale')
  })

  it('localDateToUtcMidnight builds the @db.Date query value', () => {
    expect(localDateToUtcMidnight('2027-12-25').toISOString()).toBe('2027-12-25T00:00:00.000Z')
  })
})
