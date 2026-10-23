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

  it('a "+" before a US number reads as US in a two-number cell too (PR 13)', () => {
    expect(phonesInCell('+917 555 0123')).toEqual(['+19175550123'])
    expect(phonesInCell('+917 555 0123 / 212-555-0101')).toEqual(['+19175550123', '+12125550101'])
    expect(phonesInCell('212-555-0101 / +646 555 0124')).toEqual(['+12125550101', '+16465550124'])
    // Only a space between them: each number is found in the text, then read
    // with the shared parser.
    expect(phonesInCell('212-555-0101 +646 555 0124')).toEqual(['+12125550101', '+16465550124'])
    expect(phonesInCell('212 555 0101 +929 555 0125')).toEqual(['+12125550101', '+19295550125'])
  })

  it('a "+" before a US number in a space-only two-number cell, for area codes that are not valid under any other country (review round 3)', () => {
    // 212, 347, 718, 973 and 908 read as invalid numbers under the country
    // code their own digits suggest (e.g. "+212…" as Morocco), unlike 646 and
    // 929 above, which happen to be valid under some other country's plan.
    // Before review round 3's fix, libphonenumber-js's findPhoneNumbersInText
    // never reported these as a match at all (not even a wrong one), so the
    // number was silently dropped from the import, not merely misfiled.
    expect(phonesInCell('718-555-0101 +212 555 0147')).toEqual(['+17185550101', '+12125550147'])
    expect(phonesInCell('718-555-0101 +347 555 0147')).toEqual(['+17185550101', '+13475550147'])
    expect(phonesInCell('718-555-0101 +718 555 0147')).toEqual(['+17185550101', '+17185550147'])
    expect(phonesInCell('718-555-0101 +973 555 0147')).toEqual(['+17185550101', '+19735550147'])
    expect(phonesInCell('718-555-0101 +908 555 0147')).toEqual(['+17185550101', '+19085550147'])
    // Order independence: the stray-"+" number first, not second.
    expect(phonesInCell('+212 555 0147 718-555-0101')).toEqual(['+12125550147', '+17185550101'])
    expect(phonesInCell('+917 555 0147 718-555-0101')).toEqual(['+19175550147', '+17185550101'])
    // Three numbers, space-only, one with a stray "+".
    expect(phonesInCell('718-555-0101 212-555-0102 +347 555 0103')).toEqual([
      '+17185550101',
      '+12125550102',
      '+13475550103',
    ])
    // A foreign number written in full is still found (libphonenumber's own
    // finder; a fictional UK drama number).
    expect(phonesInCell('212-555-0101 +44 20 7946 0958')).toEqual(['+12125550101', '+442079460958'])
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
