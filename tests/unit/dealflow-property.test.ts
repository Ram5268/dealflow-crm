import { describe, it, expect } from 'vitest'
import type { PrismaClient } from '@prisma/client'
import {
  MAX_COMPS,
  PERSONAL_KEY,
  compactMoney,
  toPropertyFacts,
  whitelist,
  type DealflowProperty,
} from '@/lib/core-data/dealflow-sync/property'
import { getLeadProperty } from '@/lib/core-data/dealflow-sync/property-lookup'
import { PROPERTY_SQL, RO_SQL, STUB_ROWS, buildSignals, stubBatch, type DealflowJoinRow } from '@/lib/core-data/dealflow-sync/sync'
import { assertReadOnlySql } from '@/lib/core-data/dealflow-sync/ro-client'
import { comp, facts, rawProperty, sources } from './helpers/property-fixture'

// Brief 44 (PR 5): DealFlow's own estimate of a seller's home, kept on the
// seller's signal as dealflowRawJson.property and shown only on Ryan's lead
// page. toPropertyFacts is the strict whitelist between DealFlow's database and
// the CRM (engineering precaution). Invented data only.

const flat = (sql: string) => sql.replace(/\s+/g, ' ')

// Every key at every depth.
function keysDeep(v: unknown, out: string[] = []): string[] {
  if (Array.isArray(v)) for (const x of v) keysDeep(x, out)
  else if (v && typeof v === 'object') {
    for (const [k, x] of Object.entries(v)) {
      out.push(k)
      keysDeep(x, out)
    }
  }
  return out
}

const NO_VALUE = { value: null, low: null, high: null }

describe('toPropertyFacts: the whitelist into dealflowRawJson.property', () => {
  it('keeps every contract field of a valued home, unchanged', () => {
    expect(toPropertyFacts(rawProperty())).toEqual(rawProperty())
  })

  it('drops unknown fields at every level', () => {
    const extra = { bbl: '3999990999', note: 'free text', taxLienNotice: true }
    const noisy = rawProperty({
      ...extra,
      facts: {
        ...facts({
          lastSale: { date: '2015-06-03', price: 1_200_000, ...extra },
          dofMarketValue: { value: 1_410_000, fiscalYear: 2027, ...extra },
          permits7y: { count: 2, major: true, ...extra },
          openViolations: { dob: 0, ecb: 1, hpd: 0, ...extra },
          leadVsCity: { units: { lead: 3, city: 2, ...extra }, buildingSqft: null, ...extra },
        }),
        ...extra,
      },
      comps: [{ ...comp(0), ...extra }, { ...comp(1), ...extra }],
      sources: {
        ...sources({
          datasets: { 'abcd-1234': { updatedOn: '2026-10-15', rows: 1200, ...extra }, dof_annual: { updatedOn: null, rows: 50 } },
        }),
        ...extra,
      },
    })
    const out = toPropertyFacts(noisy)
    expect(out).toEqual(rawProperty())
    expect(JSON.stringify(out)).not.toMatch(/bbl|note|taxLien|free text|3999990999/)
  })

  it('never keeps a name, owner, party, phone, email or contact key, even one a whitelist names by mistake', () => {
    const person = {
      ownerName: 'Pat Example', owner: 'Pat Example', partyName: 'Pat Example', parties: ['Pat Example'],
      firstName: 'Pat', phone: '+1 212-555-0123', email: 'pat@example.com', mailingAddress: '1 Example Ave', contactId: 'c_1',
    }
    for (const k of Object.keys(person)) expect(PERSONAL_KEY.test(k), k).toBe(true)
    for (const k of keysDeep(rawProperty())) expect(PERSONAL_KEY.test(k), k).toBe(false)

    // A whitelist that (wrongly) lists every one of them still keeps none.
    const anything = (v: unknown) => v
    const fields = Object.fromEntries([...Object.keys(person), 'units'].map((k) => [k, anything]))
    expect(whitelist({ ...person, units: 2 }, fields)).toEqual({ units: 2 })

    // And none reaches the stored property from any level.
    const out = toPropertyFacts(
      rawProperty({
        ...person,
        facts: { ...facts({ lastSale: { date: '2015-06-03', price: 1_200_000, ...person } }), ...person },
        comps: [{ ...comp(0), ...person }],
        sources: { ...sources(), ...person },
      })
    )
    expect(out?.comps).toEqual([comp(0)])
    expect(keysDeep(out).filter((k) => PERSONAL_KEY.test(k))).toEqual([])
    expect(JSON.stringify(out)).not.toMatch(/Pat|555-0123|example\.com|c_1/)
  })

  it('refuses bad numbers, codes and dates field by field', () => {
    const out = toPropertyFacts(
      rawProperty({
        facts: facts({
          units: 2.5, buildingSqft: '2400', lotSqft: 0, yearBuilt: 1600, floors: 250, zoning: 'r6b', buildingClass: 'B12',
          historicDistrict: 'yes', lastSale: { date: '2015-02-30', price: 1_200_000 },
          dofMarketValue: { value: 1_410_000, fiscalYear: 1999 }, permits7y: { count: -1, major: true },
          openViolations: { dob: 0, ecb: 1.5, hpd: 0 }, subwayMiles: 30,
          leadVsCity: { units: { lead: 'three', city: 2 }, buildingSqft: { lead: 2400, city: Infinity } },
        }),
      })
    )
    expect(out?.facts).toEqual({
      units: null, buildingSqft: null, lotSqft: null, yearBuilt: null, floors: null, zoning: null, buildingClass: null,
      historicDistrict: null, lastSale: null, dofMarketValue: null, permits7y: null, openViolations: null, subwayMiles: null,
      leadVsCity: { units: null, buildingSqft: null },
    })
    // Codes are codes: nothing else, and nothing long.
    for (const zoning of ['R6B<b>', 'R6B; x', 'R6B '.repeat(5), 'R'.repeat(17), 42]) {
      expect(toPropertyFacts(rawProperty({ facts: facts({ zoning }) }))?.facts?.zoning, String(zoning)).toBeNull()
    }
    expect(toPropertyFacts(rawProperty({ facts: facts({ zoning: 'M1-2/R6A' }) }))?.facts?.zoning).toBe('M1-2/R6A')
  })

  it('keeps a value only with a sane range around it, and nearby sales only with a value', () => {
    const bad = [
      { value: 1_830_000, low: 2_000_000, high: 2_120_000 }, // low above the value
      { value: 1_830_000, low: 1_540_000, high: 1_700_000 }, // value above the high end
      { value: 1_830_000, low: 1_540_000, high: null }, // no high end
      { value: 1_830_000, low: 800_000, high: 2_120_000 }, // low under half the value
      { value: 1_830_000, low: 1_540_000, high: 4_000_000 }, // high over twice the value
      { value: '1830000', low: 1_540_000, high: 2_120_000 }, // not a number
      { value: -5, low: -6, high: -4 },
      { value: 2e9, low: 1.5e9, high: 2.5e9 }, // over the cap
      { value: Infinity, low: 1_540_000, high: Infinity },
    ]
    for (const v of bad) {
      const out = toPropertyFacts(rawProperty(v))
      expect([out?.value, out?.low, out?.high], JSON.stringify(v)).toEqual([null, null, null])
      expect(out?.comps).toEqual([])
    }
  })

  it('accepts only real ISO dates, and only sales before the as-of date', () => {
    for (const asOf of ['2026-10-1', '2026-13-01', '2026-02-30', 'Oct 1, 2026', '2026-10-01T00:00:00Z', 20261001, null, '1850-01-01']) {
      expect(toPropertyFacts(rawProperty({ asOf })), String(asOf)).toBeNull()
    }
    const out = toPropertyFacts(
      rawProperty({
        dataThrough: '2026-09-31',
        publishedAt: 'yesterday',
        facts: facts({ lastSale: { date: '2026-10-01', price: 1_200_000 } }), // on the as-of day: not an earlier sale
        comps: [comp(0), comp(1, { date: '2026-10-01' }), comp(2, { date: '2026-10-05' }), comp(3, { date: '2026-9-12' })],
      })
    )
    expect(out?.dataThrough).toBeNull()
    expect(out?.publishedAt).toBeNull()
    expect(out?.facts?.lastSale).toBeNull()
    expect(out?.comps).toEqual([comp(0)])
  })

  it('reads the publish time Postgres writes into JSON as a UTC ISO time', () => {
    expect(toPropertyFacts(rawProperty({ publishedAt: '2026-10-20T06:31:00.5-04:00' }))?.publishedAt).toBe('2026-10-20T10:31:00.500Z')
    expect(toPropertyFacts(rawProperty({ publishedAt: '2026-10-20T10:31:00.123456+00:00' }))?.publishedAt).toBe('2026-10-20T10:31:00.123Z')
  })

  it(`keeps at most ${MAX_COMPS} nearby sales, in DealFlow's order, each with every field valid`, () => {
    const many = Array.from({ length: 12 }, (_, i) => comp(i))
    expect(toPropertyFacts(rawProperty({ comps: many }))?.comps).toEqual(many.slice(0, 8))
    const bad = [
      comp(0, { address: 'Example St' }), // no house number
      comp(0, { address: 'J Example St' }), // a letter is not a house number
      comp(0, { address: ' Example St' }),
      comp(0, { address: '12 Example St; x' }),
      comp(0, { address: `12 ${'Example '.repeat(12)}St` }), // too long
      comp(0, { address: 12 }),
      comp(0, { distanceMiles: 2 }), // too far to be nearby
      comp(0, { pricePerSqft: 60_000 }),
      comp(0, { price: 0 }),
      comp(0, { date: null }),
      { address: '12 Example St' },
      'a sale',
      null,
    ]
    for (const c of bad) expect(toPropertyFacts(rawProperty({ comps: [c, comp(7)] }))?.comps, JSON.stringify(c)).toEqual([comp(7)])
  })

  it('a home without a value keeps its reason and its facts, and no sales', () => {
    for (const reason of ['five_plus_units', 'condo_without_unit', 'other_property_type'] as const) {
      const out = toPropertyFacts(rawProperty({ ...NO_VALUE, reason, comps: [comp(0)] }))
      expect(out).toMatchObject({ ...NO_VALUE, reason, comps: [] })
      expect(out?.facts).toEqual(facts())
    }
    expect(toPropertyFacts(rawProperty({ ...NO_VALUE, reason: 'not_found', facts: null, comps: [] }))).toMatchObject({
      reason: 'not_found',
      facts: null,
    })
    expect(toPropertyFacts(rawProperty({ ...NO_VALUE, reason: 'owner_said_no' }))?.reason).toBeNull() // unknown reason
    expect(toPropertyFacts(rawProperty({ reason: 'five_plus_units' }))?.reason).toBeNull() // a valued home has no reason
  })

  it('sources: dates and codes checked, at most 30 datasets, each id a dataset id', () => {
    const out = toPropertyFacts(
      rawProperty({
        sources: {
          downloadedOn: '2026-10-18', salesThrough: 'Sep 30', plutoVersion: '26v2; x', rollFiscalYear: 1999,
          datasets: {
            'abcd-1234': { updatedOn: 'today', rows: 5 }, dof_annual: { updatedOn: '2026-10-01', rows: 50 },
            'not a dataset': { updatedOn: null, rows: 1 }, 'name-0001': { updatedOn: null, rows: 1 },
            'efgh-5678': { updatedOn: null, rows: -1 }, 'ijkl-9012': 'x',
          },
        },
      })
    )
    expect(out?.sources).toEqual({
      downloadedOn: '2026-10-18', salesThrough: null, plutoVersion: null, rollFiscalYear: null,
      datasets: { 'abcd-1234': { updatedOn: null, rows: 5 }, dof_annual: { updatedOn: '2026-10-01', rows: 50 } },
    })
    const forty = Object.fromEntries(Array.from({ length: 40 }, (_, i) => [`ab${String(i).padStart(2, '0')}-1234`, { updatedOn: null, rows: i }]))
    expect(Object.keys(toPropertyFacts(rawProperty({ sources: sources({ datasets: forty }) }))?.sources?.datasets ?? {})).toHaveLength(30)
  })

  it('null or garbage in: null out; facts, sales and sources of the wrong shape come out empty', () => {
    for (const v of [null, undefined, 'x', 42, true, [], [rawProperty()], {}, { asOf: null }]) {
      expect(toPropertyFacts(v), JSON.stringify(v)).toBeNull()
    }
    expect(toPropertyFacts(rawProperty({ facts: 'x', comps: { 0: comp(0) }, sources: [1] }))).toMatchObject({
      facts: null,
      comps: [],
      sources: null,
    })
  })

  it('whitelisting what it already stored changes nothing (the lead page whitelists again on read)', () => {
    const once = toPropertyFacts(rawProperty({ publishedAt: '2026-10-20T06:31:00.5-04:00' }))
    expect(toPropertyFacts(JSON.parse(JSON.stringify(once)))).toEqual(once)
  })
})

describe('the sync carries the property', () => {
  const row = (property: unknown) =>
    ({ mojo_id: 'mojo_1', crm_lead_id: 'lead_1', generated_at: '2026-10-20T09:18:08Z', property }) as unknown as DealflowJoinRow

  it('buildSignals stores the whitelisted property on the signal', () => {
    const [s] = buildSignals({ includeTestBuyers: true, rows: [row({ ...rawProperty(), ownerName: 'Pat Example', bbl: '3999990999' })] })
    expect(s.dealflowRawJson.property).toEqual(rawProperty())
  })

  it('a seller without a published valuation gets property: null', () => {
    for (const p of [null, undefined, 'garbage']) {
      expect(buildSignals({ includeTestBuyers: true, rows: [row(p)] })[0].dealflowRawJson.property).toBeNull()
    }
  })

  it('stub mode (DEALFLOW_SYNC_STUB=1) exercises the card with an invented home', () => {
    expect(STUB_ROWS[0].property).toBeTruthy()
    const [s] = buildSignals(stubBatch(new Date('2026-10-20T11:00:00Z')))
    const p = s.dealflowRawJson.property as DealflowProperty
    expect(p).toMatchObject({ value: expect.any(Number), reason: null })
    expect(p.facts).not.toBeNull()
    expect(p.comps.length).toBeGreaterThan(0)
    expect(p.comps.every((c) => / Example /.test(` ${c.address} `))).toBe(true) // invented addresses
  })
})

describe('PROPERTY_SQL: the read from DealFlow', () => {
  it('is part of RO_SQL, which stays one read-only statement the client accepts', () => {
    expect(RO_SQL).toContain(`${PROPERTY_SQL} AS property`)
    expect(() => assertReadOnlySql(RO_SQL)).not.toThrow()
  })

  it("reads only the entry's contact's newest PUBLISHED valuation", () => {
    const sql = flat(PROPERTY_SQL)
    expect(sql).toContain('FROM "PropertyValuation" pv JOIN "ValuationRun" vr ON vr."id" = pv."runId"')
    expect(sql).toContain('WHERE pv."contactId" = cqe."contactId" AND vr."published" = true')
    expect(sql).toContain('ORDER BY vr."publishedAt" DESC NULLS LAST LIMIT 1')
  })

  it('selects exactly the card fields: no tax lot, nothing about a person', () => {
    const keys = [...PROPERTY_SQL.matchAll(/'(\w+)', (?:pv|vr|to_char)\b/g)].map((m) => m[1])
    expect(keys.sort()).toEqual(['asOf', 'comps', 'dataThrough', 'facts', 'high', 'low', 'publishedAt', 'reason', 'sources', 'value'])
    const columns = new Set([...PROPERTY_SQL.matchAll(/\b(?:pv|vr)\."(\w+)"/g)].map((m) => m[1]))
    expect([...columns].sort()).toEqual([
      'asOf', 'compsJson', 'contactId', 'dataThrough', 'factsJson', 'high', 'id', 'low', 'published', 'publishedAt',
      'reason', 'runId', 'sourcesJson', 'value',
    ])
    expect(PROPERTY_SQL).not.toMatch(/bbl|name|owner|party|phone|email|address/i)
  })
})

describe('getLeadProperty: the lead page read', () => {
  function fakeDb(rows: unknown[]) {
    const calls: { sql: string; values: unknown[] }[] = []
    const db = {
      $queryRaw: async (strings: TemplateStringsArray, ...values: unknown[]) => {
        calls.push({ sql: strings.join('?'), values })
        return rows
      },
    }
    return { db: db as unknown as PrismaClient, calls }
  }

  it("reads the lead's stored property and whitelists it again", async () => {
    const f = fakeDb([{ property: { ...rawProperty(), ownerName: 'Pat Example' } }])
    expect(await getLeadProperty('org_1', { id: 'lead_1', mojoId: 'mojo_1' }, f.db)).toEqual(rawProperty())
    expect(flat(f.calls[0].sql)).toContain(`SELECT s."dealflowRawJson"->'property' AS property FROM "DealFlowDerivedSignal" s`)
    // The lead's signal is found the way getLeadBuyers finds it: crmLeadId, else mojoId.
    expect(f.calls[0].values).toEqual(['org_1', 'lead_1', 'mojo_1', 'org_1'])
  })

  it('no signal, or a signal synced before this card existed: null', async () => {
    expect(await getLeadProperty('org_1', { id: 'lead_1', mojoId: null }, fakeDb([]).db)).toBeNull()
    expect(await getLeadProperty('org_1', { id: 'lead_1', mojoId: null }, fakeDb([{ property: null }]).db)).toBeNull()
  })
})

describe('compact money', () => {
  it('reads like the card: $1.83M, $875K', () => {
    expect([1_830_000, 875_000, 999_600, 999_400, 2_000_000, 1_500_000].map(compactMoney)).toEqual([
      '$1.83M', '$875K', '$1M', '$999K', '$2M', '$1.5M',
    ])
  })
})
