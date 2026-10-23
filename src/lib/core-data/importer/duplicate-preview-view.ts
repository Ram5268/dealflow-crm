// Brief 50 PR 6 (open item 6.6): before an import is committed, the review
// screen says how many rows look like people already in the CRM, with a short
// list, so Ryan sees what will merge:
//   "32 of 412 rows look like people already in your CRM. They'll be merged
//    into those leads, not added again."
//   "Row 7: Test Owner, phone ending 0123 → Test Owner (same Mojo ID)"
// Only the last 4 digits of a phone are shown. Pure and browser-safe; the
// numbers come from duplicate-preview.ts.

/** Which rule matched the row (commit-worker's findExistingLead, in its order). */
export type MatchVia = 'mojo' | 'phone' | 'name-address'

export interface DuplicateMatchDTO {
  /** The row's line in the file (the header is line 1), as in the import's error list. */
  row: number
  /** The row's name as the import would show it. */
  name: string
  /** Last 4 digits of the row's first phone; never the whole number. */
  phoneLast4: string | null
  leadId: string
  leadName: string
  via: MatchVia
}

export interface DuplicatePreviewDTO {
  totalRows: number
  /** Rows actually checked: fewer than totalRows when the check hit its time limit. */
  checkedRows: number
  /** Rows that match a lead already in the CRM: the commit merges them into it. */
  existing: number
  /** Rows with no Mojo ID, phone, name or address: the commit skips them. */
  unidentified: number
  /** The first few of `existing`, in file order. */
  matches: DuplicateMatchDTO[]
}

/** How many matches the list shows; the rest are counted. */
export const MATCH_LIST_LIMIT = 20

const count = (n: number) => n.toLocaleString('en-US')

export function duplicateHeadline(p: DuplicatePreviewDTO): string {
  const rows = `${count(p.totalRows)} ${p.totalRows === 1 ? 'row' : 'rows'}`
  if (p.existing === 0) return p.totalRows === 1 ? "The row doesn't match anyone already in your CRM." : `None of the ${rows} match someone already in your CRM.`
  return p.existing === 1
    ? `1 of ${rows} looks like someone already in your CRM. It'll be merged into that lead, not added again.`
    : `${count(p.existing)} of ${rows} look like people already in your CRM. They'll be merged into those leads, not added again.`
}

const VIA: Record<MatchVia, string> = {
  mojo: 'same Mojo ID',
  phone: 'same phone',
  'name-address': 'same name and address',
}

export function matchLine(m: DuplicateMatchDTO): string {
  const phone = m.phoneLast4 ? `, phone ending ${m.phoneLast4}` : ''
  return `Row ${m.row}: ${m.name}${phone} → ${m.leadName} (${VIA[m.via]})`
}

export function moreLine(p: DuplicatePreviewDTO): string | null {
  const rest = p.existing - p.matches.length
  return rest > 0 ? `…and ${count(rest)} more.` : null
}

/** Said when the check stopped early (time limit): the counts cover the first rows only. */
export function partialLine(p: DuplicatePreviewDTO): string | null {
  if (p.checkedRows >= p.totalRows) return null
  return `Checked the first ${count(p.checkedRows)} of ${count(p.totalRows)} rows; the counts above are for those rows only. The import itself checks every row.`
}

export function unidentifiedLine(n: number): string | null {
  if (n <= 0) return null
  return n === 1
    ? '1 row has no Mojo ID, phone, name or address, so it will be skipped.'
    : `${count(n)} rows have no Mojo ID, phone, name or address, so they will be skipped.`
}
