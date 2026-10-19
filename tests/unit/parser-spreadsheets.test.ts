import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import * as XLSX from 'xlsx'
import { parseFile, sampleValues } from '@/lib/core-data/importer/parser'
import { rawXlsx, workbookBuffer, type FakeSheet } from './helpers/fake-spreadsheets'

// Brief 50 PR 8 (open item 6.13, plus 6.6's "only the first Excel sheet is
// read"). Every file format the import takes, built in memory from made-up
// rows: the upload screen offers .csv, .xlsx and .xls; the upload route itself
// takes any file, and the parser reads .xlsx/.xls (any case) as Excel and
// everything else as CSV text.

const HEAD = ['Full Name', 'Phone', 'Address']
const BROOKLYN: FakeSheet = {
  name: 'Brooklyn',
  rows: [HEAD, ['Test Owner 1', '212-555-0101', '100 Example St'], ['Test Owner 2', '212-555-0102', '102 Example St']],
}
const QUEENS: FakeSheet = { name: 'Queens', rows: [HEAD, ['Test Owner 3', '718-555-0103', '300 Sample Ave']] }
const EMPTY: FakeSheet = { name: 'Notes', rows: [] }

// Anything a test file manages to add to Object.prototype is removed again,
// so a failure here can't leak into other test files sharing the process.
let protoBefore: string[] = []
beforeEach(() => {
  protoBefore = Object.getOwnPropertyNames(Object.prototype)
})
afterEach(() => {
  for (const k of Object.getOwnPropertyNames(Object.prototype)) {
    if (!protoBefore.includes(k)) delete (Object.prototype as Record<string, unknown>)[k]
  }
})
const protoAdded = () => Object.getOwnPropertyNames(Object.prototype).filter((k) => !protoBefore.includes(k))

describe('the spreadsheet library version', () => {
  it('is 0.20.2 or later (fixes CVE-2023-30533 and CVE-2024-22363)', () => {
    const [major, minor, patch] = XLSX.version.split('.').map(Number)
    expect(major * 1_000_000 + minor * 1_000 + patch).toBeGreaterThanOrEqual(20_002)
  })
})

describe.each(['xlsx', 'xls'] as const)('parseFile — .%s workbooks', (bookType) => {
  const file = `owners.${bookType}`

  it('reads a one-sheet workbook as before', () => {
    const parsed = parseFile(workbookBuffer([BROOKLYN], bookType), file)
    expect(parsed.headerRow).toEqual(HEAD)
    expect(parsed.totalRowsDetected).toBe(2)
    expect(parsed.allRows[1]).toEqual({ 'Full Name': 'Test Owner 2', Phone: '212-555-0102', Address: '102 Example St' })
    expect(parsed.sheets).toEqual([{ name: 'Brooklyn', rows: 2, columns: HEAD }])
  })

  it('reads every sheet that has rows, in tab order, and says which it read', () => {
    const parsed = parseFile(workbookBuffer([BROOKLYN, EMPTY, QUEENS], bookType), file)
    expect(parsed.headerRow).toEqual(HEAD)
    expect(parsed.totalRowsDetected).toBe(3)
    expect(parsed.allRows.map((r) => r['Full Name'])).toEqual(['Test Owner 1', 'Test Owner 2', 'Test Owner 3'])
    expect(parsed.allRows[2]).toEqual({ 'Full Name': 'Test Owner 3', Phone: '718-555-0103', Address: '300 Sample Ave' })
    expect(parsed.sampleRows).toHaveLength(3)
    expect(parsed.sheets).toEqual([
      { name: 'Brooklyn', rows: 2, columns: HEAD },
      { name: 'Notes', rows: 0, columns: [], skipped: 'empty' },
      { name: 'Queens', rows: 1, columns: HEAD },
    ])
  })

  it('reads the data when the first sheet is empty', () => {
    const parsed = parseFile(workbookBuffer([{ name: 'Sheet1', rows: [] }, { ...QUEENS, name: 'Data' }], bookType), file)
    expect(parsed.headerRow).toEqual(HEAD)
    expect(parsed.allRows.map((r) => r['Full Name'])).toEqual(['Test Owner 3'])
  })

  it('keeps every column when sheets have different columns (the rest left blank)', () => {
    const calls: FakeSheet = { name: 'Called', rows: [['Full Name', 'Email'], ['Test Owner 4', 'owner4@example.com']] }
    const parsed = parseFile(workbookBuffer([BROOKLYN, calls], bookType), file)
    expect(parsed.headerRow).toEqual(['Full Name', 'Phone', 'Address', 'Email'])
    expect(parsed.allRows[0]).toEqual({ 'Full Name': 'Test Owner 1', Phone: '212-555-0101', Address: '100 Example St', Email: '' })
    expect(parsed.allRows[2]).toEqual({ 'Full Name': 'Test Owner 4', Phone: '', Address: '', Email: 'owner4@example.com' })
    expect(parsed.sheets?.map((s) => [s.name, s.rows, s.columns])).toEqual([
      ['Brooklyn', 2, HEAD],
      ['Called', 1, ['Full Name', 'Email']],
    ])
  })

  it('skips hidden sheets and says so', () => {
    const lookups: FakeSheet = { name: 'Lookups', rows: [['Code', 'Meaning'], ['A', 'Active']], hidden: true }
    const parsed = parseFile(workbookBuffer([BROOKLYN, lookups], bookType), file)
    expect(parsed.headerRow).toEqual(HEAD)
    expect(parsed.totalRowsDetected).toBe(2)
    expect(parsed.sheets?.[1]).toEqual({ name: 'Lookups', rows: 0, columns: [], skipped: 'hidden' })
  })

  it('returns nothing (and does not throw) when every sheet is empty', () => {
    const parsed = parseFile(workbookBuffer([{ name: 'Sheet1', rows: [] }, { name: 'Sheet2', rows: [] }], bookType), file)
    expect(parsed).toMatchObject({ headerRow: [], totalRowsDetected: 0, allRows: [], sampleRows: [] })
    expect(parsed.sheets?.map((s) => s.skipped)).toEqual(['empty', 'empty'])
  })

  it('turns numbers and true/false into text', () => {
    const sheet: FakeSheet = { name: 'S', rows: [['Full Name', 'Phone', 'Owner Occupied'], ['Test Owner 5', 2125550105, true]] }
    const parsed = parseFile(workbookBuffer([sheet], bookType), file)
    expect(parsed.allRows[0]).toEqual({ 'Full Name': 'Test Owner 5', Phone: '2125550105', 'Owner Occupied': 'true' })
  })

  it('keeps two columns with the same name (and the same name with spaces) apart', () => {
    const sheet: FakeSheet = { name: 'S', rows: [['Full Name', 'Phone', 'Phone', ' Phone '], ['Test Owner 6', '212-555-0106', '212-555-0107', '212-555-0108']] }
    const parsed = parseFile(workbookBuffer([sheet], bookType), file)
    expect(parsed.headerRow).toEqual(['Full Name', 'Phone', 'Phone_1', 'Phone_2'])
    expect(parsed.allRows[0]).toEqual({ 'Full Name': 'Test Owner 6', Phone: '212-555-0106', Phone_1: '212-555-0107', Phone_2: '212-555-0108' })
  })

  it('a "__proto__" / "constructor" / "toString" column is plain data and pollutes nothing', () => {
    const sheet: FakeSheet = {
      name: 'S',
      rows: [
        ['Full Name', '__proto__', 'constructor', 'toString'],
        ['Test Owner 7', 'p7', 'c7', 't7'],
        ['Test Owner 8', null, null, null],
      ],
    }
    const parsed = parseFile(workbookBuffer([sheet], bookType), file)
    expect(protoAdded()).toEqual([])
    expect(parsed.headerRow).toEqual(['Full Name', '__proto__', 'constructor', 'toString'])
    const [a, b] = parsed.allRows
    expect(Object.keys(a)).toEqual(['Full Name', '__proto__', 'constructor', 'toString'])
    expect([a['__proto__'], a['constructor'], a['toString']]).toEqual(['p7', 'c7', 't7'])
    expect([b['__proto__'], b['constructor'], b['toString']]).toEqual(['', '', ''])
    expect(sampleValues(parsed.allRows, 'constructor')).toEqual(['c7'])
    expect(sampleValues(parsed.allRows, 'hasOwnProperty')).toEqual([])
  })

  it('accepts an upper-case extension', () => {
    const parsed = parseFile(workbookBuffer([BROOKLYN, QUEENS], bookType), `OWNERS.${bookType.toUpperCase()}`)
    expect(parsed.totalRowsDetected).toBe(3)
  })
})

describe('parseFile — .xlsx files Excel writes, built by hand', () => {
  it('a crafted comment aimed at "__proto__" does not pollute every object (CVE-2023-30533)', () => {
    const buf = rawXlsx([['Full Name', 'Phone'], ['Test Owner 9', '212-555-0109']], { commentRef: '__proto__' })
    const parsed = parseFile(buf, 'crafted.xlsx')
    expect(protoAdded()).toEqual([])
    expect(({} as Record<string, unknown>).c).toBeUndefined()
    expect(parsed.allRows).toEqual([{ 'Full Name': 'Test Owner 9', Phone: '212-555-0109' }])
  })

  it('reads Excel date cells as the same moment in any time zone', () => {
    const buf = rawXlsx([
      ['Full Name', 'Sale Date', 'Called At'],
      ['Test Owner 10', { n: 45306, style: 1 }, { n: 45306.75, style: 2 }],
    ])
    const parsed = parseFile(buf, 'dates.xlsx')
    expect(parsed.allRows[0]).toEqual({ 'Full Name': 'Test Owner 10', 'Sale Date': '2024-01-15T00:00:00.000Z', 'Called At': '2024-01-15T18:00:00.000Z' })
  })
})

describe('parseFile — other files', () => {
  it('reads an .xls that is really tab-separated text (some web tools export that)', () => {
    const tsv = 'Full Name\tPhone\nTest Owner 11\t212-555-0111\n'
    const parsed = parseFile(Buffer.from(tsv), 'export.xls')
    expect(parsed.headerRow).toEqual(['Full Name', 'Phone'])
    expect(parsed.allRows).toEqual([{ 'Full Name': 'Test Owner 11', Phone: '212-555-0111' }])
  })

  it('reads any other extension as CSV text', () => {
    const parsed = parseFile(Buffer.from('Full Name,Phone\nTest Owner 12,212-555-0112\n'), 'owners.txt')
    expect(parsed.allRows).toEqual([{ 'Full Name': 'Test Owner 12', Phone: '212-555-0112' }])
    expect(parsed.sheets).toEqual([])
  })
})

describe('parseFile — CSV', () => {
  it('reads a Windows-1252 file (Excel "CSV" on Windows) without garbling accents', () => {
    // "Test Ownér" (é = 0xE9) and "Test O’Brien" (’ = 0x92): not valid UTF-8.
    const buf = Buffer.concat([
      Buffer.from('Full Name,Phone\r\nTest Own'), Buffer.from([0xe9]), Buffer.from('r,212-555-0113\r\nTest O'),
      Buffer.from([0x92]), Buffer.from('Brien,212-555-0114\r\n'),
    ])
    const parsed = parseFile(buf, 'owners.csv')
    expect(parsed.allRows.map((r) => r['Full Name'])).toEqual(['Test Ownér', 'Test O’Brien'])
  })

  it('reads UTF-8 with or without a byte-order mark', () => {
    const text = 'Full Name,Phone\nTest Ownér,212-555-0115\n'
    for (const buf of [Buffer.from(text), Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(text)])]) {
      const parsed = parseFile(buf, 'owners.csv')
      expect(parsed.headerRow).toEqual(['Full Name', 'Phone'])
      expect(parsed.allRows).toEqual([{ 'Full Name': 'Test Ownér', Phone: '212-555-0115' }])
    }
  })

  it('keeps two columns with the same name apart', () => {
    const parsed = parseFile(Buffer.from('Full Name,Phone,Phone\nTest Owner 16,212-555-0116,212-555-0117\n'), 'owners.csv')
    expect(parsed.headerRow).toEqual(['Full Name', 'Phone', 'Phone_1'])
    expect(parsed.allRows[0]).toEqual({ 'Full Name': 'Test Owner 16', Phone: '212-555-0116', Phone_1: '212-555-0117' })
  })

  it('fills a short row with blanks', () => {
    const parsed = parseFile(Buffer.from('Full Name,Phone,Address\nTest Owner 18,212-555-0118\n'), 'owners.csv')
    expect(parsed.allRows).toEqual([{ 'Full Name': 'Test Owner 18', Phone: '212-555-0118', Address: '' }])
  })

  it('a "__proto__" / "constructor" column is plain data and pollutes nothing', () => {
    const csv = 'Full Name,__proto__,constructor\nTest Owner 19,p19,c19\nTest Owner 20\n'
    const parsed = parseFile(Buffer.from(csv), 'owners.csv')
    expect(protoAdded()).toEqual([])
    expect(parsed.headerRow).toEqual(['Full Name', '__proto__', 'constructor'])
    expect([parsed.allRows[0]['__proto__'], parsed.allRows[0]['constructor']]).toEqual(['p19', 'c19'])
    expect([parsed.allRows[1]['__proto__'], parsed.allRows[1]['constructor']]).toEqual(['', ''])
    expect(sampleValues(parsed.allRows, '__proto__')).toEqual(['p19'])
    expect(sampleValues(parsed.allRows, 'constructor')).toEqual(['c19'])
  })
})
