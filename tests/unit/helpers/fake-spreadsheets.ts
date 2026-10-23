import * as XLSX from 'xlsx'

// Brief 50 PR 8: small made-up spreadsheets for the import parser's tests,
// built in memory (no files checked in). Everything is fictional: "Test Owner"
// names, "Example St" streets, phones only in 555-0100…0199.

export type FakeCell = string | number | boolean | Date | null

export interface FakeSheet {
  name: string
  rows: FakeCell[][]
  hidden?: boolean | 'very' // 'very': Excel's "very hidden" (only a macro can show it)
}

// A workbook in an Excel format, written by the spreadsheet library itself:
// 'xlsx' (Excel 2007+) or 'xls' (Excel 97–2003, BIFF8).
export function workbookBuffer(sheets: FakeSheet[], bookType: 'xlsx' | 'xls'): Buffer {
  const wb = XLSX.utils.book_new()
  for (const s of sheets) XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(s.rows), s.name)
  wb.Workbook = { Sheets: sheets.map((s) => ({ name: s.name, Hidden: s.hidden === 'very' ? 2 : s.hidden ? 1 : 0 })) }
  return XLSX.write(wb, { type: 'buffer', bookType }) as Buffer
}

// --- A hand-built .xlsx (the zip of XML parts), independent of the library ---
// Used for files the library would never write itself: a crafted comment that
// targets "__proto__" (CVE-2023-30533), and Excel's own date cells (a serial
// number plus a date style).

const CRC_TABLE = (() => {
  const t = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    t[n] = c >>> 0
  }
  return t
})()

function crc32(buf: Buffer): number {
  let c = 0xffffffff
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

// A zip with every part stored uncompressed.
export function zipStored(parts: Record<string, string>): Buffer {
  const chunks: Buffer[] = []
  const central: Buffer[] = []
  let offset = 0
  for (const [name, text] of Object.entries(parts)) {
    const data = Buffer.from(text, 'utf8')
    const fileName = Buffer.from(name, 'utf8')
    const crc = crc32(data)
    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(20, 4)
    local.writeUInt16LE(0x21, 12) // a fixed 1980 date
    local.writeUInt32LE(crc, 14)
    local.writeUInt32LE(data.length, 18)
    local.writeUInt32LE(data.length, 22)
    local.writeUInt16LE(fileName.length, 26)
    const entry = Buffer.alloc(46)
    entry.writeUInt32LE(0x02014b50, 0)
    entry.writeUInt16LE(20, 4)
    entry.writeUInt16LE(20, 6)
    entry.writeUInt16LE(0x21, 14)
    entry.writeUInt32LE(crc, 16)
    entry.writeUInt32LE(data.length, 20)
    entry.writeUInt32LE(data.length, 24)
    entry.writeUInt16LE(fileName.length, 28)
    entry.writeUInt32LE(offset, 42)
    chunks.push(local, fileName, data)
    central.push(entry, fileName)
    offset += local.length + fileName.length + data.length
  }
  const dir = Buffer.concat(central)
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0)
  end.writeUInt16LE(central.length / 2, 8)
  end.writeUInt16LE(central.length / 2, 10)
  end.writeUInt32LE(dir.length, 12)
  end.writeUInt32LE(offset, 16)
  return Buffer.concat([...chunks, dir, end])
}

const XML = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
const MAIN = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main'
const REL = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships'
const PKG_REL = 'http://schemas.openxmlformats.org/package/2006/relationships'
const CT = 'application/vnd.openxmlformats-officedocument.spreadsheetml'

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

// One raw cell: text, or a number with an optional style (1 = a date,
// 2 = a date and time; see the styles part below).
export type RawCell = string | { n: number; style?: 1 | 2 }

// A one-sheet .xlsx from raw cells, optionally with one comment whose cell
// reference is written exactly as given (Excel would only write "A1" etc.),
// and optionally with the sheet's used range (its <dimension>) written as
// given: Brief 50 PR 20's "A1:Z1048576" for a sheet with a few rows, as a
// stray formatted cell at the bottom leaves it.
export function rawXlsx(rows: RawCell[][], opts: { commentRef?: string; dimension?: string } = {}): Buffer {
  const colName = (c: number) => String.fromCharCode(65 + c)
  const sheetRows = rows
    .map((cells, r) => {
      const xmlCells = cells
        .map((cell, c) => {
          const ref = `${colName(c)}${r + 1}`
          if (typeof cell === 'string') return `<c r="${ref}" t="inlineStr"><is><t>${esc(cell)}</t></is></c>`
          return `<c r="${ref}"${cell.style ? ` s="${cell.style}"` : ''}><v>${cell.n}</v></c>`
        })
        .join('')
      return `<row r="${r + 1}">${xmlCells}</row>`
    })
    .join('')
  const parts: Record<string, string> = {
    '[Content_Types].xml':
      `${XML}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">` +
      '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
      '<Default Extension="xml" ContentType="application/xml"/>' +
      `<Override PartName="/xl/workbook.xml" ContentType="${CT}.sheet.main+xml"/>` +
      `<Override PartName="/xl/worksheets/sheet1.xml" ContentType="${CT}.worksheet+xml"/>` +
      `<Override PartName="/xl/styles.xml" ContentType="${CT}.styles+xml"/>` +
      (opts.commentRef !== undefined ? `<Override PartName="/xl/comments1.xml" ContentType="${CT}.comments+xml"/>` : '') +
      '</Types>',
    '_rels/.rels': `${XML}<Relationships xmlns="${PKG_REL}"><Relationship Id="rId1" Type="${REL}/officeDocument" Target="xl/workbook.xml"/></Relationships>`,
    'xl/workbook.xml': `${XML}<workbook xmlns="${MAIN}" xmlns:r="${REL}"><sheets><sheet name="Sheet1" sheetId="1" r:id="rId1"/></sheets></workbook>`,
    'xl/_rels/workbook.xml.rels':
      `${XML}<Relationships xmlns="${PKG_REL}">` +
      `<Relationship Id="rId1" Type="${REL}/worksheet" Target="worksheets/sheet1.xml"/>` +
      `<Relationship Id="rId2" Type="${REL}/styles" Target="styles.xml"/>` +
      '</Relationships>',
    'xl/styles.xml':
      `${XML}<styleSheet xmlns="${MAIN}"><fonts count="1"><font/></fonts><fills count="1"><fill/></fills>` +
      '<borders count="1"><border/></borders><cellStyleXfs count="1"><xf/></cellStyleXfs>' +
      '<cellXfs count="3"><xf numFmtId="0"/><xf numFmtId="14" applyNumberFormat="1"/><xf numFmtId="22" applyNumberFormat="1"/></cellXfs>' +
      '</styleSheet>',
    'xl/worksheets/sheet1.xml':
      `${XML}<worksheet xmlns="${MAIN}">` +
      (opts.dimension !== undefined ? `<dimension ref="${esc(opts.dimension)}"/>` : '') +
      `<sheetData>${sheetRows}</sheetData></worksheet>`,
  }
  if (opts.commentRef !== undefined) {
    parts['xl/worksheets/_rels/sheet1.xml.rels'] =
      `${XML}<Relationships xmlns="${PKG_REL}"><Relationship Id="rId1" Type="${REL}/comments" Target="../comments1.xml"/></Relationships>`
    parts['xl/comments1.xml'] =
      `${XML}<comments xmlns="${MAIN}"><authors><author>Test Author</author></authors><commentList>` +
      `<comment ref="${esc(opts.commentRef)}" authorId="0"><text><t>A made-up note</t></text></comment>` +
      '</commentList></comments>'
  }
  return zipStored(parts)
}
