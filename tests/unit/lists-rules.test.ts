import { describe, it, expect } from 'vitest'
import {
  normalizeName, nameProblem, isGroupColor, attemptsFrom, compareRank, tierOf, rankStateOf, type RankKey,
} from '@/lib/core-data/lists/rules'
import { boroughOf, neighborhoodOf, unitsOf, zip5, NYC_ZIP_NEIGHBORHOODS } from '@/lib/core-data/lists/geo'
import { csvCell, toCsv } from '@/lib/core-data/lists/csv'
import { GROUP_COLORS, BULK_MAX, PAGE_SIZE } from '@/lib/core-data/lists/types'

// Brief 45 PR A — the pure rules behind folders, lists, groups and ranking.

describe('names [Ryan 2026-10-18; brief §5.1]', () => {
  it('normalizes to NFC and trims', () => {
    expect(normalizeName('  Hot  ')).toBe('Hot')
    expect(normalizeName('Café')).toBe('Café')
  })

  it('accepts 1–60 characters, counted as people read them', () => {
    expect(nameProblem('a')).toBeNull()
    expect(nameProblem('x'.repeat(60))).toBeNull()
    expect(nameProblem('😀'.repeat(60))).toBeNull() // 60 emoji are 60 characters, not 120
    expect(nameProblem('  ' + 'x'.repeat(60) + '  ')).toBeNull()
    for (const bad of ['', '   ', 'x'.repeat(61), undefined, null, 7, {}]) {
      expect(nameProblem(bad)).toBe('Name must be 1–60 characters.')
    }
  })

  it('refuses line breaks and other control characters', () => {
    expect(nameProblem('Hot\nleads')).toMatch(/line breaks/)
    expect(nameProblem('Hot\u0000')).toMatch(/line breaks/)
  })
})

describe('group colors', () => {
  it('is a fixed set', () => {
    expect(GROUP_COLORS).toEqual(['gray', 'red', 'orange', 'yellow', 'green', 'teal', 'blue', 'purple', 'pink'])
    expect(isGroupColor('teal')).toBe(true)
    expect(isGroupColor('Teal')).toBe(false)
    expect(isGroupColor('#00ffff')).toBe(false)
    expect(isGroupColor(undefined)).toBe(false)
  })

  it('limits and page size', () => {
    expect(BULK_MAX).toBe(5_000)
    expect(PAGE_SIZE).toBe(100)
  })
})

describe('call attempts (Mojo "Call Attempts") [CONTRACT §3]', () => {
  it('valueNumber, else a strictly numeric valueText, else 0', () => {
    expect(attemptsFrom(4, null)).toBe(4)
    expect(attemptsFrom(4, '9')).toBe(4)
    expect(attemptsFrom(null, ' 3 ')).toBe(3)
    expect(attemptsFrom(null, '2.5')).toBe(2.5)
    expect(attemptsFrom(null, '\t7\n')).toBe(7)
    for (const t of ['three', '-1', '1e3', '3 calls', '', ' ', '.5', '5.', '١٢', null, undefined]) {
      expect(attemptsFrom(null, t)).toBe(0)
    }
  })
})

describe('compareRank mirrors the SQL order [brief §5.5]', () => {
  const k = (id: string, priorityScore: number | null, topMatchFit: number | null, attempts: number, createdAt: string): RankKey =>
    ({ id, priorityScore, topMatchFit, attempts, createdAt: new Date(createdAt) })
  const T = '2026-10-01T12:00:00Z'

  it('priority desc (nulls last), fit desc (nulls last), attempts asc, createdAt asc, id asc', () => {
    const rows = [
      k('n2', null, null, 0, '2026-10-02T00:00:00Z'),
      k('n1', null, null, 0, T),
      k('nf', null, 99, 0, T),
      k('z', 0, 10, 0, T),
      k('i', 80, null, 0, T),
      k('c3', 80, 70, 3, T),
      k('c1', 80, 70, 1, T),
      k('b', 80, 70, 0, '2026-10-01T13:00:00Z'),
      k('a', 80, 70, 0, '2026-10-01T13:00:00Z'),
      k('e', 80, 70, 0, T),
      k('f', 80, 90, 9, T),
      k('top', 90, null, 5, T),
    ]
    expect([...rows].sort(compareRank).map((r) => r.id)).toEqual(['top', 'f', 'e', 'a', 'b', 'c1', 'c3', 'i', 'z', 'nf', 'n1', 'n2'])
  })

  it('ids compare by code unit, like COLLATE "C"', () => {
    const r = (id: string) => k(id, 1, 1, 0, T)
    expect([r('b'), r('B'), r('a'), r('_')].sort(compareRank).map((x) => x.id)).toEqual(['B', '_', 'a', 'b'])
  })

  it('accepts ISO strings for createdAt', () => {
    expect(compareRank({ ...k('a', 1, 1, 0, T), createdAt: '2026-10-01T12:00:00.000Z' }, k('b', 1, 1, 0, '2026-10-01T12:00:01Z'))).toBeLessThan(0)
  })
})

describe('tiers (DealFlow lib/matching/tiers.ts: HOT ≥ 80, WARM ≥ 65)', () => {
  it('maps topMatchFit to a tier', () => {
    expect(tierOf(80)).toBe('hot')
    expect(tierOf(79)).toBe('warm')
    expect(tierOf(65)).toBe('warm')
    expect(tierOf(64)).toBe('possible')
    expect(tierOf(0)).toBe('possible')
    expect(tierOf(null)).toBe('none')
  })
})

describe('rank state [CONTRACT §3]', () => {
  const cutoff = new Date('2026-10-18T09:00:00Z')
  const before = new Date('2026-10-17T09:00:00Z')
  const after = new Date('2026-10-18T13:00:00Z')
  const row = (o: Partial<{ priorityScore: number | null; dealflowSignalSyncedAt: Date | null; mojoId: string | null; createdAt: Date }>) =>
    ({ priorityScore: null, dealflowSignalSyncedAt: null, mojoId: 'm', createdAt: after, ...o })

  it('ranked / not ranked (no match, no Mojo ID) / scoring', () => {
    expect(rankStateOf(row({ priorityScore: 0 }), cutoff)).toEqual({ rankState: 'ranked', notRankedReason: null })
    expect(rankStateOf(row({ dealflowSignalSyncedAt: after, mojoId: null }), cutoff)).toEqual({ rankState: 'not_ranked', notRankedReason: 'no_match' })
    expect(rankStateOf(row({ createdAt: before }), cutoff)).toEqual({ rankState: 'not_ranked', notRankedReason: 'no_match' })
    expect(rankStateOf(row({ mojoId: null }), cutoff)).toEqual({ rankState: 'not_ranked', notRankedReason: 'no_mojo_id' })
    expect(rankStateOf(row({ mojoId: null, createdAt: before }), cutoff)).toEqual({ rankState: 'not_ranked', notRankedReason: 'no_mojo_id' })
    expect(rankStateOf(row({}), cutoff)).toEqual({ rankState: 'scoring', notRankedReason: null })
    expect(rankStateOf(row({ createdAt: before }), null)).toEqual({ rankState: 'scoring', notRankedReason: null }) // never ranked yet
  })
})

describe('geography [CONTRACT §4]', () => {
  it('reads the ZIP (5 digits, ZIP+4 allowed)', () => {
    expect(zip5('11215')).toBe('11215')
    expect(zip5(' 10013-1234 ')).toBe('10013')
    expect(zip5('1121')).toBeNull()
    expect(zip5(null)).toBeNull()
  })

  it('borough from the ZIP first, then the city', () => {
    expect(boroughOf('10001', null)).toBe('Manhattan')
    expect(boroughOf('10282', null)).toBe('Manhattan')
    expect(boroughOf('10301', null)).toBe('Staten Island')
    expect(boroughOf('10451', null)).toBe('Bronx')
    expect(boroughOf('11201', null)).toBe('Brooklyn')
    expect(boroughOf('11101', null)).toBe('Queens')
    expect(boroughOf('11385', null)).toBe('Queens')
    expect(boroughOf('11432', null)).toBe('Queens')
    expect(boroughOf('11691', null)).toBe('Queens')
    expect(boroughOf('11004', null)).toBe('Queens')
    expect(boroughOf('11005', null)).toBe('Queens')
    expect(boroughOf('11001', 'Floral Park')).toBeNull() // Nassau County
    expect(boroughOf('11215', 'Queens')).toBe('Brooklyn') // the ZIP wins
    expect(boroughOf(null, 'Brooklyn')).toBe('Brooklyn')
    expect(boroughOf(null, ' new york ')).toBe('Manhattan')
    expect(boroughOf(null, 'The Bronx')).toBe('Bronx')
    expect(boroughOf(null, 'Long Island City')).toBe('Queens')
    expect(boroughOf(null, 'Staten Island')).toBe('Staten Island')
    expect(boroughOf('07030', 'Hoboken')).toBeNull()
    expect(boroughOf(null, null)).toBeNull()
  })

  it('neighborhood from the ZIP (a copy of DealFlow lib/geo/zipNeighborhood.ts)', () => {
    expect(neighborhoodOf('11215')).toBe('Park Slope')
    expect(neighborhoodOf('11233-0001')).toBe('Bedford-Stuyvesant')
    expect(neighborhoodOf('11207')).toBeNull() // spans several neighborhoods: deliberately unmapped
    expect(Object.keys(NYC_ZIP_NEIGHBORHOODS)).toHaveLength(44)
  })

  it('units from the Property Type, as DealFlow lib/crm-sync/mapLead.ts', () => {
    expect(unitsOf('Duplex')).toBe(2)
    expect(unitsOf(' Triplex ')).toBe(3)
    expect(unitsOf('Quadruplex')).toBe(4)
    expect(unitsOf('Apartment House (5+ Units)')).toBe(5)
    expect(unitsOf('Apartment  House (5+ Units)')).toBe(5) // whitespace collapsed, like mapLead's clean()
    expect(unitsOf('Single Family Residence')).toBe(1)
    expect(unitsOf('Condominium')).toBeNull()
    expect(unitsOf(null)).toBeNull()
  })
})

describe('CSV', () => {
  it('quotes commas, quotes and newlines', () => {
    expect(csvCell('a,b')).toBe('"a,b"')
    expect(csvCell('say "hi"')).toBe('"say ""hi"""')
    expect(csvCell('two\nlines')).toBe('"two\nlines"')
    expect(csvCell(null)).toBe('')
    expect(csvCell(42)).toBe('42')
  })

  it('neutralizes spreadsheet formulas in text cells [engineering precaution]', () => {
    for (const s of ['=1+1', '+1', '-1', '@SUM(A1)', '\tx', '\rx']) expect(csvCell(s).replace(/^"|"$/g, '').startsWith("'")).toBe(true)
    expect(csvCell(-1)).toBe('-1') // numbers stay numbers
  })

  it('joins rows with newlines and no trailing newline', () => {
    expect(toCsv(['A', 'B'], [[1, 'x'], [2, 'y,z']])).toBe('A,B\n1,x\n2,"y,z"')
  })
})
