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
// - Rows are objects with no prototype, so a column named "__proto__" or
//   "constructor" is plain data and a missing one reads as undefined.
// Brief 50 PR 20:
// - An Excel file is read from its first visible tab only [the planner's
//   review, Brief 50 Revision 2, 2026-10-23: an import can't be undone]. PR 8
//   had also read every later tab with about the same columns, so a vendor's
//   "DNC" or "Removed" tab in the same layout would have become ordinary
//   leads, and a stale backup tab ("Sheet1 (2)") would have overwritten newer
//   names and statuses. The other tabs are named on the review screen
//   (tabsForReview below) instead.
// - At most the first SHEET_ROW_LIMIT rows of a tab are read [engineering
//   precaution]; see readSheet.

export interface SheetRead {
  name: string
  rows: number // data rows taken from this tab
  columns: string[] // the tab's column names, in order ([] when it wasn't read or is empty)
  // Why no rows were taken: the first visible tab has none ('empty'), the tab
  // is hidden, or it isn't the first visible tab (never read).
  skipped?: 'empty' | 'hidden' | 'not-first-tab'
  rowLimitReached?: true // the tab goes on past row SHEET_ROW_LIMIT, which wasn't read
}

interface SheetGrid {
  columns: string[]
  rows: unknown[][]
  rowLimitReached: boolean
}

export interface ParsedFile {
  headerRow: string[]
  sampleRows: Record<string, string>[] // first N rows keyed by header
  totalRowsDetected: number
  allRows: Record<string, string>[]
  // Excel only: each tab in tab order, read or not (empty for CSV), so the
  // review screen can say which tabs weren't imported.
  sheets?: SheetRead[]
}

// Rows 1 to 100,000 of a tab (Excel's own row numbers, the header included)
// at most [engineering precaution]: a tab whose used range runs to row
// 1,048,576 (one stray formatted cell at the bottom) took ~14 s to read
// before, and the cap also bounds the memory a huge tab can take (every tab
// of the workbook is parsed). The import had no row limit before, only the
// upload's 100 MB file size; a CSV still has none (its rows are all really
// in the file, so the 100 MB limit bounds it).
export const SHEET_ROW_LIMIT = 100_000

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

// UTF-8 (with or without a byte-order mark); a file with no UTF-8 letters at
// all is read as Windows-1252, which is what Excel on Windows saves as "CSV".
// A file that is mostly UTF-8 with a stray byte keeps its UTF-8 letters (only
// that byte becomes "\ufffd", as before).
function decodeText(buffer: Buffer): string {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(buffer)
  } catch {
    const utf8 = new TextDecoder('utf-8').decode(buffer)
    return /[^\u0000-\u007f\ufffd]/.test(utf8) ? utf8 : new TextDecoder('windows-1252').decode(buffer)
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
  // Values only: formulas and rich-text HTML aren't read at all. sheetRows
  // reads one row past the limit, only to tell whether the tab goes on.
  const wb = XLSX.read(buffer, { type: 'buffer', cellDates: true, cellFormula: false, cellHTML: false, sheetRows: SHEET_ROW_LIMIT + 1 })
  const sheets: SheetRead[] = []
  let found: SheetGrid | null = null
  let first = true
  for (const [i, name] of wb.SheetNames.entries()) {
    // The first tab Excel shows is the one read: a hidden tab (Hidden 1, or 2
    // for "very hidden") is usually a lookup table, not people to import.
    const props = wb.Workbook?.Sheets?.find((s) => s.name === name) ?? wb.Workbook?.Sheets?.[i]
    if (props?.Hidden) {
      sheets.push({ name, rows: 0, columns: [], skipped: 'hidden' })
      continue
    }
    if (!first) {
      sheets.push({ name, rows: 0, columns: [], skipped: 'not-first-tab' })
      continue
    }
    first = false
    // An empty first tab imports nothing: the next tab is never read in its
    // place (it could be the "DNC" tab).
    found = readSheet(wb.Sheets[name])
    if (!found) sheets.push({ name, rows: 0, columns: [], skipped: 'empty' })
    else sheets.push({ name, rows: found.rows.length, columns: found.columns, ...(found.rowLimitReached ? { rowLimitReached: true as const } : {}) })
  }
  if (!found) return result([], [], sampleSize, sheets)
  const { columns, rows } = found
  const index = new Map(columns.map((name, i) => [name, i]))
  return result(columns, rows.map((cells) => toRow(columns, index, cells)), sampleSize, sheets)
}

// The header is the tab's first non-blank row (as the text Excel shows; a
// blank header cell is "__EMPTY", SheetJS's name); the data rows are the
// non-blank rows below it, up to row SHEET_ROW_LIMIT. A tab with no data rows
// counts as empty.
function readSheet(ws: XLSX.WorkSheet | undefined): SheetGrid | null {
  if (!ws?.['!ref']) return null
  // sheetRows already cut the used range at the row after the limit (or at
  // the last row really in the file, if that comes first), so a range that
  // claims row 1,048,576 costs nothing.
  // UTC: an Excel date is the same moment whatever the server's time zone
  // (production runs in UTC, so its dates don't change). No defval: a blank
  // row stays an empty array, which keeps the memory small.
  const range = XLSX.utils.decode_range(ws['!ref'])
  const grid = XLSX.utils.sheet_to_json<unknown[]>(ws, { header: 1, blankrows: true, UTC: true })
  const blank = (cells: unknown[] | undefined) => !cells || cells.every((v) => v === null || v === undefined)
  // grid[k] is row range.s.r + k (0-based): rows from index `keep` on are past
  // the limit. The tab goes on past the limit when the row after it has
  // something, or when its rows run right up to the limit and the file's own
  // range carries on (the row after was blank; '!fullref' is the range before
  // sheetRows cut it). A range that only claims more rows, after data that
  // ends well before the limit, is not "cut".
  const keep = Math.max(0, SHEET_ROW_LIMIT - range.s.r)
  const rowLimitReached =
    grid.slice(keep).some((cells) => !blank(cells)) || (ws['!fullref'] !== undefined && keep > 0 && !blank(grid[keep - 1]))
  if (grid.length > keep) grid.length = keep

  const at = grid.findIndex((cells) => !blank(cells))
  if (at === -1) return null
  const rows = grid.slice(at + 1).filter((cells) => !blank(cells))
  if (rows.length === 0) return null
  const r = range.s.r + at
  const raw: string[] = []
  for (let c = range.s.c; c <= range.e.c; c++) {
    const cell = ws[XLSX.utils.encode_cell({ r, c })] as XLSX.CellObject | undefined
    raw.push(cell ? XLSX.utils.format_cell(cell) : '__EMPTY')
  }
  return { columns: uniqueNames(raw), rows, rowLimitReached }
}

// What the import review screen says about an Excel file's tabs (null for a
// CSV): the tab read, the others (which aren't imported) and whether the tab
// read was cut at the row limit. Tab names come from the uploaded file, so at
// most `max` are named, each shortened and without control or text-direction
// characters (the screen renders them as text). Never logged.
export interface TabsForReview {
  read: string | null // the first visible tab (null: every tab is hidden)
  notImported: { name: string; hidden: boolean }[] // the other tabs, in tab order, at most `max`
  more: number // other tabs beyond those named
  rowLimit: number | null // SHEET_ROW_LIMIT when the tab read goes on past it
}

const NAME_MAX = 60
function tabName(name: string): string {
  const clean = name.replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028-\u202e\u2060-\u206f\ufeff]/g, '').trim()
  return clean.length > NAME_MAX ? `${clean.slice(0, NAME_MAX - 1)}\u2026` : clean
}

export function tabsForReview(parsed: ParsedFile, max = 10): TabsForReview | null {
  const sheets = parsed.sheets ?? []
  if (sheets.length === 0) return null
  const read = sheets.find((s) => s.skipped === undefined || s.skipped === 'empty')
  const others = sheets.filter((s) => s !== read)
  return {
    read: read ? tabName(read.name) : null,
    notImported: others.slice(0, max).map((s) => ({ name: tabName(s.name), hidden: s.skipped === 'hidden' })),
    more: Math.max(0, others.length - max),
    rowLimit: read?.rowLimitReached ? SHEET_ROW_LIMIT : null,
  }
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
