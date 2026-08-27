import Papa from 'papaparse'
import * as XLSX from 'xlsx'

// Parses a raw CSV or XLSX buffer into a header row + sample rows for the AI
// mapper, and (for commit) into the full row set. papaparse handles quoted
// commas; xlsx handles Excel with mixed types.

export interface ParsedFile {
  headerRow: string[]
  sampleRows: Record<string, string>[] // first N rows keyed by header
  totalRowsDetected: number
  allRows: Record<string, string>[]
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

function parseCsv(buffer: Buffer, sampleSize: number): ParsedFile {
  const text = buffer.toString('utf8')
  const result = Papa.parse<Record<string, string>>(text, {
    header: true,
    skipEmptyLines: true,
    transformHeader: (h) => h.trim(),
  })
  const rows = (result.data ?? []).map((r) => {
    const out: Record<string, string> = {}
    for (const [k, v] of Object.entries(r)) out[k] = coerceCell(v)
    return out
  })
  const headerRow = result.meta.fields?.map((f) => f.trim()) ?? []
  return {
    headerRow,
    sampleRows: rows.slice(0, sampleSize),
    totalRowsDetected: rows.length,
    allRows: rows,
  }
}

function parseXlsx(buffer: Buffer, sampleSize: number): ParsedFile {
  const wb = XLSX.read(buffer, { type: 'buffer', cellDates: true })
  const sheet = wb.Sheets[wb.SheetNames[0]]
  const json = XLSX.utils.sheet_to_json<Record<string, unknown>>(sheet, { defval: '' })
  const rows = json.map((r) => {
    const out: Record<string, string> = {}
    for (const [k, v] of Object.entries(r)) out[String(k).trim()] = coerceCell(v)
    return out
  })
  const headerRow = rows.length > 0 ? Object.keys(rows[0]) : []
  return {
    headerRow,
    sampleRows: rows.slice(0, sampleSize),
    totalRowsDetected: rows.length,
    allRows: rows,
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
