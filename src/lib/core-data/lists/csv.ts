// Brief 45 — CSV for list exports. Same quoting as the Leads export
// (LeadsView), plus [engineering precaution] text that a spreadsheet would run
// as a formula (= + - @, tab, carriage return at the start) gets a leading
// apostrophe. Lead names come from uploaded files.

export function csvCell(value: unknown): string {
  if (value === null || value === undefined) return ''
  let s = String(value)
  if (typeof value === 'string' && /^[=+\-@\t\r]/.test(s)) s = `'${s}`
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
}

export function toCsv(head: readonly string[], rows: readonly (readonly unknown[])[]): string {
  return [head, ...rows].map((row) => row.map(csvCell).join(',')).join('\n')
}

/** A file-name-safe version of a list name: letters, digits, spaces → dashes. */
export function fileStem(name: string): string {
  const stem = name
    .normalize('NFKD')
    .replace(/[^A-Za-z0-9 _-]/g, '')
    .trim()
    .replace(/\s+/g, '-')
    .replace(/-{2,}/g, '-')
  return stem || 'list'
}
