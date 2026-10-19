import { describe, it, expect } from 'vitest'
import { phonesInCell, normalizePhoneE164 } from '@/lib/core-data/importer/dedup'
import { buildRowPlan, resolveMapping } from '@/lib/core-data/importer/commit-worker'
import type { ColumnMapping } from '@/lib/core-data/importer/ai-mapping'

// Brief 50 PR 6 (audit L6, raised by PR 8): a cell holding two numbers
// ("212-555-0101 / 917-555-0102") wasn't a valid number as a whole, so the
// import dropped both, silently. Now each valid number in the cell is kept, in
// the order written. A cell that is one valid number is read exactly as
// before. Fictional 555-01xx numbers only.

describe('phonesInCell', () => {
  it('one number, however it is written, is read as before', () => {
    for (const cell of ['212-555-0101', '(212) 555-0101', '+1 212 555 0101', '12125550101', '212-555-0101 x23']) {
      expect(phonesInCell(cell)).toEqual([normalizePhoneE164(cell)])
    }
    expect(phonesInCell('212-555-0101')).toEqual(['+12125550101'])
  })

  it('two numbers in one cell: both kept, in the order written', () => {
    const cases = [
      '212-555-0101 / 917-555-0102',
      '212-555-0101/917-555-0102',
      '(212) 555-0101; (917) 555-0102',
      '212.555.0101, 917.555.0102',
      '212-555-0101 or 917-555-0102',
      '212-555-0101 & 917-555-0102',
      '212-555-0101\n917-555-0102',
      '2125550101 9175550102',
      '212-555-0101 (cell) 917-555-0102 (home)',
    ]
    for (const cell of cases) expect(phonesInCell(cell), cell).toEqual(['+12125550101', '+19175550102'])
  })

  it('the same number twice is one; anything that is not a number is still dropped', () => {
    expect(phonesInCell('212-555-0101 / (212) 555-0101')).toEqual(['+12125550101'])
    expect(phonesInCell('212-555-0101 / call after 6')).toEqual(['+12125550101'])
    for (const cell of ['', '   ', 'n/a', 'not a phone', '555-0101', '10/19/2026']) expect(phonesInCell(cell), cell).toEqual([])
    expect(phonesInCell(null)).toEqual([])
    expect(phonesInCell(undefined)).toEqual([])
  })
})

describe('buildRowPlan with two numbers in one cell', () => {
  const mapping: ColumnMapping[] = [
    { column: 'Name', sampleValues: [], target: { kind: 'standard_field', field: 'Lead.name' }, confidence: 1, reasoning: '' },
    { column: 'Phone', sampleValues: [], target: { kind: 'standard_field', field: 'ContactPhone.phone' }, confidence: 1, reasoning: '' },
    { column: 'Phone 2', sampleValues: [], target: { kind: 'standard_field', field: 'ContactPhone.phone' }, confidence: 1, reasoning: '' },
  ]
  const resolved = resolveMapping(mapping, [])

  it('keeps every number, the first one first (it is the one matched on), without repeats across columns', () => {
    const plan = buildRowPlan({ Name: 'Test Owner One', Phone: '212-555-0101 / 917-555-0102', 'Phone 2': '917-555-0102' }, resolved)
    expect(plan.phones.map((p) => p.phoneE164)).toEqual(['+12125550101', '+19175550102'])
    expect(plan.dedup).toEqual({ kind: 'phone', key: 'phone:+12125550101' })
  })
})
