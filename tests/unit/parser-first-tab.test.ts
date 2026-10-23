import { describe, expect, it } from 'vitest'
import * as XLSX from 'xlsx'
import { parseFile, SHEET_ROW_LIMIT, tabsForReview } from '@/lib/core-data/importer/parser'
import { rawXlsx, workbookBuffer, type FakeSheet } from './helpers/fake-spreadsheets'

// Brief 50 PR 20 (Revision 2, the planner's review of 2026-10-23): an Excel
// import reads the first visible tab only, because an import can't be undone.
// PR 8 had also read every later tab with about the same columns, so a
// vendor's "DNC" tab in the same layout would have become ordinary leads, and
// a stale backup tab ("Sheet1 (2)") would have overwritten newer names and
// statuses. The other tabs are named on the review screen instead.
// The row limit is an engineering precaution: a tab whose used range runs to
// row 1,048,576 (one stray formatted cell) stalled the read for ~14 s.
// Made-up people only: "Test Owner N", "Example St", phones 555-0100…0199.

const HEAD = ['Full Name', 'Phone', 'Address']
const BROOKLYN: FakeSheet = {
  name: 'Brooklyn',
  rows: [HEAD, ['Test Owner 1', '212-555-0101', '100 Example St'], ['Test Owner 2', '212-555-0102', '102 Example St']],
}
// Another tab in exactly the first tab's layout.
const sameColumns = (name: string, n: number, extra: Partial<FakeSheet> = {}): FakeSheet => ({
  name,
  rows: [HEAD, [`Test Owner ${n}`, `212-555-01${n}`, `${n} Example St`]],
  ...extra,
})
const names = (rows: Record<string, string>[]) => rows.map((r) => r['Full Name'])

describe.each(['xlsx', 'xls'] as const)('Excel imports read the first visible tab only (.%s)', (bookType) => {
  const file = `owners.${bookType}`

  it('a second tab with the same columns (a vendor\'s "DNC" tab) is not imported, and is named for the review screen', () => {
    const parsed = parseFile(workbookBuffer([BROOKLYN, sameColumns('DNC', 30)], bookType), file)
    expect(names(parsed.allRows)).toEqual(['Test Owner 1', 'Test Owner 2'])
    expect(parsed.totalRowsDetected).toBe(2)
    expect(parsed.headerRow).toEqual(HEAD)
    expect(parsed.sheets).toEqual([
      { name: 'Brooklyn', rows: 2, columns: HEAD },
      { name: 'DNC', rows: 0, columns: [], skipped: 'not-first-tab' },
    ])
    expect(tabsForReview(parsed)).toEqual({ read: 'Brooklyn', notImported: [{ name: 'DNC', hidden: false }], more: 0, rowLimit: null })
  })

  it('a stale backup tab ("Sheet1 (2)") with the same people never reaches the import', () => {
    const current: FakeSheet = { name: 'Sheet1', rows: [[...HEAD, 'Status'], ['Test Owner 3', '212-555-0103', '103 Example St', 'Called']] }
    const backup: FakeSheet = { name: 'Sheet1 (2)', rows: [[...HEAD, 'Status'], ['Test Owner 3 Old', '212-555-0103', '103 Example St', 'New']] }
    const parsed = parseFile(workbookBuffer([current, backup], bookType), file)
    expect(parsed.allRows).toEqual([{ 'Full Name': 'Test Owner 3', Phone: '212-555-0103', Address: '103 Example St', Status: 'Called' }])
    expect(tabsForReview(parsed)?.notImported).toEqual([{ name: 'Sheet1 (2)', hidden: false }])
  })

  it('a hidden first tab is skipped: the first tab Excel shows is read, and both others are named', () => {
    const lookups = sameColumns('Lookups', 40, { hidden: true })
    const parsed = parseFile(workbookBuffer([lookups, BROOKLYN, sameColumns('Queens', 41)], bookType), file)
    expect(names(parsed.allRows)).toEqual(['Test Owner 1', 'Test Owner 2'])
    expect(parsed.sheets?.map((s) => [s.name, s.rows, s.skipped])).toEqual([
      ['Lookups', 0, 'hidden'],
      ['Brooklyn', 2, undefined],
      ['Queens', 0, 'not-first-tab'],
    ])
    expect(tabsForReview(parsed)).toEqual({
      read: 'Brooklyn',
      notImported: [{ name: 'Lookups', hidden: true }, { name: 'Queens', hidden: false }],
      more: 0,
      rowLimit: null,
    })
  })

  it('a "very hidden" first tab is skipped too', () => {
    const parsed = parseFile(workbookBuffer([sameColumns('Macro Data', 42, { hidden: 'very' }), BROOKLYN], bookType), file)
    expect(names(parsed.allRows)).toEqual(['Test Owner 1', 'Test Owner 2'])
    expect(tabsForReview(parsed)?.notImported).toEqual([{ name: 'Macro Data', hidden: true }])
  })

  it('an empty first tab imports nothing: the next tab is not read in its place', () => {
    const parsed = parseFile(workbookBuffer([{ name: 'Sheet1', rows: [] }, sameColumns('Data', 43)], bookType), file)
    expect(parsed).toMatchObject({ headerRow: [], totalRowsDetected: 0, allRows: [], sampleRows: [] })
    expect(parsed.sheets).toEqual([
      { name: 'Sheet1', rows: 0, columns: [], skipped: 'empty' },
      { name: 'Data', rows: 0, columns: [], skipped: 'not-first-tab' },
    ])
    expect(tabsForReview(parsed)).toEqual({ read: 'Sheet1', notImported: [{ name: 'Data', hidden: false }], more: 0, rowLimit: null })
  })

  it('a workbook whose every tab is hidden imports nothing', () => {
    const parsed = parseFile(workbookBuffer([sameColumns('A', 44, { hidden: true }), sameColumns('B', 45, { hidden: true })], bookType), file)
    expect(parsed.totalRowsDetected).toBe(0)
    expect(tabsForReview(parsed)).toEqual({
      read: null,
      notImported: [{ name: 'A', hidden: true }, { name: 'B', hidden: true }],
      more: 0,
      rowLimit: null,
    })
  })
})

describe('tabsForReview: the tab names the review screen shows', () => {
  it('names at most 10 tabs, then says how many more', () => {
    const tabs = Array.from({ length: 13 }, (_, i) => sameColumns(`Tab ${i + 2}`, 50 + i))
    const parsed = parseFile(workbookBuffer([BROOKLYN, ...tabs], 'xlsx'), 'owners.xlsx')
    const t = tabsForReview(parsed)
    expect(t?.notImported.map((n) => n.name)).toEqual(Array.from({ length: 10 }, (_, i) => `Tab ${i + 2}`))
    expect(t?.more).toBe(3)
  })

  it('a long tab name is shortened, and control and text-direction characters are dropped', () => {
    const parsed: Parameters<typeof tabsForReview>[0] = {
      headerRow: HEAD,
      sampleRows: [],
      totalRowsDetected: 0,
      allRows: [],
      sheets: [
        { name: 'Brooklyn', rows: 0, columns: [], skipped: 'empty' },
        { name: 'x'.repeat(200), rows: 0, columns: [], skipped: 'not-first-tab' },
        { name: 'Tab‮TXT\u0007\n', rows: 0, columns: [], skipped: 'not-first-tab' },
      ],
    }
    const t = tabsForReview(parsed)
    expect(t?.notImported[0].name).toBe(`${'x'.repeat(59)}…`)
    expect(t?.notImported[1].name).toBe('TabTXT')
  })

  it('a CSV has no tabs: nothing to say', () => {
    expect(tabsForReview(parseFile(Buffer.from('Full Name,Phone\nTest Owner 1,212-555-0101\n'), 'owners.csv'))).toBeNull()
  })
})

// A tall one-tab .xlsx: a header on row 1 and "Test Owner <row>" on rows 2 to
// lastRow (row `gapAt` left blank), written uncompressed (quick to build).
function tallXlsx(lastRow: number, opts: { gapAt?: number; range?: string } = {}): Buffer {
  const ws: XLSX.WorkSheet = { A1: { t: 's', v: 'Full Name' }, B1: { t: 's', v: 'Phone' } }
  for (let r = 2; r <= lastRow; r++) {
    if (r === opts.gapAt) continue
    ws[`A${r}`] = { t: 's', v: `Test Owner ${r}` }
    ws[`B${r}`] = { t: 's', v: `212-555-01${String(r % 100).padStart(2, '0')}` }
  }
  ws['!ref'] = opts.range ?? `A1:B${lastRow}`
  const wb = XLSX.utils.book_new()
  XLSX.utils.book_append_sheet(wb, ws, 'Data')
  return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx', compression: false }) as Buffer
}

describe('the per-tab row limit (Excel)', () => {
  it('is rows 1 to 100,000 of the tab', () => {
    expect(SHEET_ROW_LIMIT).toBe(100_000)
  })

  it('a tab whose range runs to row 1,048,576 with a few rows of data reads quickly and is not cut', { timeout: 60_000 }, () => {
    const buf = rawXlsx([['Full Name', 'Phone'], ['Test Owner 1', '212-555-0101'], ['Test Owner 2', '212-555-0102']], { dimension: 'A1:Z1048576' })
    const started = performance.now()
    const parsed = parseFile(buf, 'stray-format.xlsx')
    expect(performance.now() - started).toBeLessThan(3_000) // was ~14 s
    expect(names(parsed.allRows)).toEqual(['Test Owner 1', 'Test Owner 2'])
    expect(parsed.sheets).toEqual([{ name: 'Sheet1', rows: 2, columns: ['Full Name', 'Phone'] }])
    expect(tabsForReview(parsed)).toMatchObject({ notImported: [], rowLimit: null })
  })

  it('a tab with more rows: only rows 1 to 100,000 are read, and the review screen is told', { timeout: 60_000 }, () => {
    const parsed = parseFile(tallXlsx(100_005), 'tall.xlsx')
    expect(parsed.totalRowsDetected).toBe(99_999) // rows 2 to 100,000 (row 1 is the header)
    expect(parsed.allRows.at(-1)).toEqual({ 'Full Name': 'Test Owner 100000', Phone: '212-555-0100' })
    expect(parsed.sheets).toEqual([{ name: 'Data', rows: 99_999, columns: ['Full Name', 'Phone'], rowLimitReached: true }])
    expect(tabsForReview(parsed)).toEqual({ read: 'Data', notImported: [], more: 0, rowLimit: 100_000 })
  })

  it('a tab of exactly 100,000 rows is read whole and not flagged', { timeout: 60_000 }, () => {
    const parsed = parseFile(tallXlsx(100_000), 'full.xlsx')
    expect(parsed.totalRowsDetected).toBe(99_999)
    expect(parsed.sheets?.[0].rowLimitReached).toBeUndefined()
    expect(tabsForReview(parsed)?.rowLimit).toBeNull()
  })

  it('a tab whose rows reach row 100,000, skip a row and go on is flagged too', { timeout: 60_000 }, () => {
    const parsed = parseFile(tallXlsx(100_010, { gapAt: 100_001 }), 'gap.xlsx')
    expect(parsed.totalRowsDetected).toBe(99_999)
    expect(parsed.sheets?.[0].rowLimitReached).toBe(true)
  })

  it('a CSV is read whole: no row limit, no tab line', () => {
    const rows = Array.from({ length: 100_005 }, (_, i) => `Test Owner ${i + 1},212-555-01${String(i % 100).padStart(2, '0')}`)
    const parsed = parseFile(Buffer.from(['Full Name,Phone', ...rows].join('\n')), 'owners.csv')
    expect(parsed.totalRowsDetected).toBe(100_005)
    expect(parsed.sheets).toEqual([])
    expect(tabsForReview(parsed)).toBeNull()
  })
})
