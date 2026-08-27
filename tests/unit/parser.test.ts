import { describe, it, expect } from 'vitest'
import { parseFile, sampleValues } from '@/lib/core-data/importer/parser'

const CSV = `Full Name,Address,"Notes, extra",Phone
Acme LLC,"5 Main St, NY",Call attempts: 3,(212) 555-0134
Beta Corp,"9 Elm Ave, NY","Motivated, cash",212-555-0200`

describe('parseFile — CSV', () => {
  it('parses header + rows, handling quoted commas', () => {
    const parsed = parseFile(Buffer.from(CSV), 'contacts.csv')
    expect(parsed.headerRow).toEqual(['Full Name', 'Address', 'Notes, extra', 'Phone'])
    expect(parsed.totalRowsDetected).toBe(2)
    expect(parsed.allRows[0]['Address']).toBe('5 Main St, NY')
    expect(parsed.allRows[1]['Notes, extra']).toBe('Motivated, cash')
  })

  it('sampleValues returns first N non-empty', () => {
    const parsed = parseFile(Buffer.from(CSV), 'contacts.csv')
    expect(sampleValues(parsed.sampleRows, 'Full Name', 5)).toEqual(['Acme LLC', 'Beta Corp'])
  })
})
