import Papa from 'papaparse'
import * as XLSX from 'xlsx'

// Parses a raw CSV or Excel buffer into a header row + sample rows for the AI
// mapper, and (for commit) into the full row set. papaparse handles quoted
// commas; xlsx (SheetJS) handles Excel with mixed types.
//
// Brief 50 PR 8 (engineering precautions, from the 2026-10-05 audit):
// - SheetJS is 0.20.3 from SheetJS's own download site (they stopped
//   publishing to npm at 0.18.5, which has CVE-2023-30533, a crafted file
//   polluting every object, and CVE-2024-22363, slow regexes). The lockfile
//   pins the download's sha512, so a changed file fails the install.
// - Every visible sheet with rows is read, not just the first (open item 6.6).
// - Rows are objects with no prototype, so a column named "__proto__" or
//   "constructor" is plain data and a missing one reads as undefined.

export interface SheetRead {
  name: string
  rows: number // data rows taken from this sheet
  columns: string[] // this sheet's own column names, in order
  skipped?: 'empty' | 'hidden' // why none were taken
}

export interface ParsedFile {
  headerRow: string[]
  sampleRows: Record<string, string>[] // first N rows keyed by header
  totalRowsDetected: number
  allRows: Record<string, string>[]
  // Excel only: each sheet in tab order, read or skipped (empty for CSV), so
  // the review screen can say which sheets the rows came from.
  sheets?: SheetRead[]
}

function isXlsx(filename: string): boolean {
  return /\.xlsx?$/i.test(filename)
}

function coerceCell(v: unknown): string {
  if (v === null || v === undefined) return ''
  if (v instanceof Date) return v.toISOString()
  return String(v)
}

export function parseFile(buffer: Buffer, filename: string, sampleSize = 20): ParsedFile {
  if (isXlsx(filename)) return parseXlsx(buffer, sampleSize)
  return parseCsv(buffer, sampleSize)
}

// Column names are trimmed; a repeated name gets _1, _2… (skipping names the
// file already uses), the way papaparse and SheetJS name repeats. Trimming
// first keeps "Phone" and " Phone " as two columns (SheetJS's names were
// trimmed only afterwards, and the two collapsed into one).
function uniqueNames(raw: string[]): string[] {
  const names = raw.map((h) => h.trim())
  const inFile = new Set(names)
  const used = new Set<string>()
  return names.map((name) => {
    let out = name
    for (let n = 1; used.has(out) || (out !== name && inFile.has(out)); n++) out = `${name}_${n}`
    used.add(out)
    return out
  })
}

function toRow(header: string[], index: Map<string, number>, cells: readonly unknown[]): Record<string, string> {
  const row: Record<string, string> = Object.create(null)
  for (const name of header) {
    const i = index.get(name)
    row[name] = i === undefined ? '' : coerceCell(cells[i])
  }
  return row
}

function result(headerRow: string[], allRows: Record<string, string>[], sampleSize: number, sheets: SheetRead[]): ParsedFile {
  return { headerRow, sampleRows: allRows.slice(0, sampleSize), totalRowsDetected: allRows.length, allRows, sheets }
}

// UTF-8 (with or without a byte-order mark); a file that isn't valid UTF-8 is
// read as Windows-1252, which is what Excel on Windows saves as "CSV".
function decodeText(buffer: Buffer): string {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(buffer)
  } catch {
    return new TextDecoder('windows-1252').decode(buffer)
  }
}

function parseCsv(buffer: Buffer, sampleSize: number): ParsedFile {
  const parsed = Papa.parse<string[]>(decodeText(buffer), { header: false, skipEmptyLines: true })
  const [first = [], ...data] = parsed.data ?? []
  const header = uniqueNames(first)
  const index = new Map(header.map((name, i) => [name, i]))
  return result(header, data.map((cells) => toRow(header, index, cells)), sampleSize, [])
}

function parseXlsx(buffer: Buffer, sampleSize: number): ParsedFile {
  // Values only: formulas and rich-text HTML aren't read at all.
  const wb = XLSX.read(buffer, { type: 'buffer', cellDates: true, cellFormula: false, cellHTML: false })
  const sheets: SheetRead[] = []
  const found: Array<{ columns: string[]; rows: unknown[][] }> = []
  for (const [i, name] of wb.SheetNames.entries()) {
    // A hidden sheet is usually a lookup table, not people to import.
    const props = wb.Workbook?.Sheets?.find((s) => s.name === name) ?? wb.Workbook?.Sheets?.[i]
    const read = props?.Hidden ? null : readSheet(wb.Sheets[name])
    if (!read) {
      sheets.push({ name, rows: 0, columns: [], skipped: props?.Hidden ? 'hidden' : 'empty' })
      continue
    }
    sheets.push({ name, rows: read.rows.length, columns: read.columns })
    found.push(read)
  }

  // Sheets with different columns: every column is kept (in first-seen
  // order) and a sheet's rows are blank in the columns it doesn't have, so
  // no sheet's data is dropped; a sheet with unrelated columns (a summary,
  // say) leaves the mapped fields blank and those rows are skipped as rows
  // with nothing to identify an owner.
  const headerRow = [...new Set(found.flatMap((s) => s.columns))]
  const allRows = found.flatMap((s) => {
    const index = new Map(s.columns.map((name, i) => [name, i]))
    return s.rows.map((cells) => toRow(headerRow, index, cells))
  })
  return result(headerRow, allRows, sampleSize, sheets)
}

// The header is the sheet's first non-blank row (as the text Excel shows; a
// blank header cell is "__EMPTY", SheetJS's name); the data rows are the
// non-blank rows below it. A sheet with no data rows counts as empty.
function readSheet(ws: XLSX.WorkSheet | undefined): { columns: string[]; rows: unknown[][] } | null {
  if (!ws?.['!ref']) return null
  // UTC: an Excel date is the same moment whatever the server's time zone
  // (production runs in UTC, so its dates don't change).
  const grid = XLSX.utils.sheet_to_json<unknown[]>(ws, { header: 1, defval: null, blankrows: true, UTC: true })
  const blank = (cells: unknown[]) => cells.every((v) => v === null || v === undefined)
  const at = grid.findIndex((cells) => !blank(cells))
  if (at === -1) return null
  const rows = grid.slice(at + 1).filter((cells) => !blank(cells))
  if (rows.length === 0) return null
  const range = XLSX.utils.decode_range(ws['!ref'])
  const r = range.s.r + at
  const raw: string[] = []
  for (let c = range.s.c; c <= range.e.c; c++) {
    const cell = ws[XLSX.utils.encode_cell({ r, c })] as XLSX.CellObject | undefined
    raw.push(cell ? XLSX.utils.format_cell(cell) : '__EMPTY')
  }
  return { columns: uniqueNames(raw), rows }
}

// First N non-null sample values for a given column (for the mapping proposal).
export function sampleValues(rows: Record<string, string>[], column: string, n = 5): string[] {
  const out: string[] = []
  for (const r of rows) {
    const v = r[column]
    if (v !== undefined && v !== null && v !== '') {
      out.push(v)
      if (out.length >= n) break
    }
  }
  return out
}
