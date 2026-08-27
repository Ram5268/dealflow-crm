import { describe, it, expect } from 'vitest'
import { generateHolidayRows, runHolidayRefresh } from '@/lib/compliance/holidays/refresh'

describe('generateHolidayRows (real date-holidays)', () => {
  const rows = generateHolidayRows({ orgId: 'org_x', years: [2027] })

  const has = (scope: string, dateIso: string) =>
    rows.some((r) => r.scope === scope && r.date.toISOString().slice(0, 10) === dateIso)

  it('emits federal public holidays with scope "federal"', () => {
    expect(has('federal', '2027-01-18')).toBe(true) // MLK
    expect(has('federal', '2027-05-31')).toBe(true) // Memorial
    expect(has('federal', '2027-07-04')).toBe(true) // Independence
    expect(has('federal', '2027-11-25')).toBe(true) // Thanksgiving
    expect(has('federal', '2027-12-25')).toBe(true) // Christmas
  })

  it('emits state-specific holidays with scope "state:XX"', () => {
    expect(has('state:MA', '2027-04-19')).toBe(true) // Patriots' Day (MA)
    expect(has('state:CA', '2027-03-31')).toBe(true) // César Chávez Day (CA)
  })

  it('never emits a state row on a federal date (federal already blocks everyone)', () => {
    const federalDates = new Set(rows.filter((r) => r.scope === 'federal').map((r) => r.date.toISOString().slice(0, 10)))
    const stateOnFederalDate = rows.filter(
      (r) => r.scope.startsWith('state:') && federalDates.has(r.date.toISOString().slice(0, 10))
    )
    expect(stateOnFederalDate).toEqual([])
  })

  it('stores dates at UTC midnight', () => {
    for (const r of rows) expect(r.date.toISOString().endsWith('T00:00:00.000Z')).toBe(true)
  })

  it('is deduplicated (no duplicate scope+date pairs)', () => {
    const keys = rows.map((r) => `${r.scope}|${r.date.toISOString().slice(0, 10)}`)
    expect(new Set(keys).size).toBe(keys.length)
  })

  it('dedupes across a repeated year and honors a custom trackedStates list', () => {
    // The same year twice forces both the federal and state seen-key branches.
    const dup = generateHolidayRows({ orgId: 'o', years: [2027, 2027], trackedStates: ['MA'] })
    const keys = dup.map((r) => `${r.scope}|${r.date.toISOString().slice(0, 10)}`)
    expect(new Set(keys).size).toBe(keys.length) // no duplicates despite repeated year
    // Only MA state rows (custom trackedStates), plus federal.
    const stateScopes = new Set(dup.filter((r) => r.scope.startsWith('state:')).map((r) => r.scope))
    expect([...stateScopes]).toEqual(['state:MA'])
  })
})

describe('runHolidayRefresh', () => {
  it('createMany with skipDuplicates and reports counts', async () => {
    let received: any
    const db = {
      holidaySuppressionDate: {
        createMany: async (args: any) => {
          received = args
          return { count: args.data.length }
        },
      },
    }
    const res = await runHolidayRefresh({ orgId: 'org_x', years: [2027] }, db)
    expect(received.skipDuplicates).toBe(true)
    expect(res.generated).toBeGreaterThan(0)
    expect(res.written).toBe(res.generated)
    expect(received.data[0]).toMatchObject({ organizationId: 'org_x' })
  })

  it('defaults to current + next year when years omitted', async () => {
    let count = 0
    const db = {
      holidaySuppressionDate: { createMany: async (args: any) => ((count = args.data.length), { count }) },
    }
    const res = await runHolidayRefresh({ orgId: 'org_x', now: new Date('2027-06-01T00:00:00Z') }, db)
    // Two years of federal (~15 each) + state-specific => comfortably > 30.
    expect(res.generated).toBeGreaterThan(30)
  })
})
