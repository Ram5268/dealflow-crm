import type { TabsForReview } from '@/lib/core-data/importer/parser'

// Brief 50 PR 20: an Excel import reads its first visible tab only [the
// planner's review, Brief 50 Revision 2, 2026-10-23: an import can't be
// undone], so the review screen names the file's other tabs, which aren't
// imported, and says plainly when the tab read went on past the row limit
// [engineering precaution]. Tab names come from the uploaded file: they're
// rendered as text (React escapes them), never as markup.

const quoted = (name: string) => `“${name}”`

function tabList(tabs: TabsForReview): string {
  const names = tabs.notImported.map((t) => `${quoted(t.name)}${t.hidden ? ' (hidden)' : ''}`).join(', ')
  return tabs.more > 0 ? `${names} and ${tabs.more} more` : names
}

/** The line naming the tabs that aren't imported; null when there are none. */
export function notImportedLine(tabs: TabsForReview, totalRows: number): string | null {
  if (tabs.notImported.length === 0) return null
  if (tabs.read === null) return `Every tab in this file is hidden, so nothing is imported. Not imported: ${tabList(tabs)}.`
  const empty = totalRows === 0
  return (
    `Only the first tab, ${quoted(tabs.read)}, is imported${empty ? ', and it has no rows' : ''}. ` +
    `Also in this file, not imported: ${tabList(tabs)}.` +
    (empty ? ' To import another tab, move it to the front in Excel and upload the file again.' : '')
  )
}

/** Said when the tab read goes on past the row limit; null otherwise. */
export function rowLimitLine(tabs: TabsForReview): string | null {
  if (tabs.rowLimit === null || tabs.read === null) return null
  return (
    `Only rows 1 to ${tabs.rowLimit.toLocaleString('en-US')} of ${quoted(tabs.read)} were read. ` +
    "The rest of that tab won't be imported; to import it, upload those rows as a separate file."
  )
}

export function FileTabsNote({ tabs, totalRows }: { tabs: TabsForReview | null | undefined; totalRows: number }) {
  if (!tabs) return null
  const tabsLine = notImportedLine(tabs, totalRows)
  const limitLine = rowLimitLine(tabs)
  return (
    <>
      {limitLine && (
        <p role="status" className="mb-3 rounded-md bg-warning-subtle p-3 text-base text-warning" data-testid="row-limit-note">
          {limitLine}
        </p>
      )}
      {tabsLine && (
        <p className="mb-3 rounded-md border border-line bg-elevated p-3 text-base text-fg break-words" data-testid="file-tabs-note">
          {tabsLine}
        </p>
      )}
    </>
  )
}
