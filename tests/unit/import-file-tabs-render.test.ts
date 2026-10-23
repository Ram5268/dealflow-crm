import { describe, expect, it } from 'vitest'
import { createElement as h } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { FileTabsNote } from '@/app/imports/[id]/mapping-review/FileTabsNote'
import type { TabsForReview } from '@/lib/core-data/importer/parser'

// Brief 50 PR 20 (Revision 2, the planner's review of 2026-10-23): the import
// review screen names the tabs of an Excel file that weren't imported (only
// the first tab is), and says plainly when a tab was cut at the row limit.
// Tab names come from the uploaded file, so they're rendered as text.

const decode = (s: string) => s.replace(/&#x27;/g, "'").replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&')
const text = (html: string) => decode(html.replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim()
const render = (tabs: TabsForReview | null, totalRows = 2) => renderToStaticMarkup(h(FileTabsNote, { tabs, totalRows }))
const tabs = (over: Partial<TabsForReview> = {}): TabsForReview => ({ read: 'Brooklyn', notImported: [], more: 0, rowLimit: null, ...over })

describe('FileTabsNote', () => {
  it('names the other tabs, which are not imported', () => {
    const html = render(tabs({ notImported: [{ name: 'DNC', hidden: false }, { name: 'Sheet1 (2)', hidden: false }] }))
    expect(text(html)).toBe('Only the first tab, “Brooklyn”, is imported. Also in this file, not imported: “DNC”, “Sheet1 (2)”.')
    expect(html).toContain('data-testid="file-tabs-note"')
  })

  it('shows nothing for a CSV or a one-tab workbook', () => {
    expect(render(null)).toBe('')
    expect(render(tabs())).toBe('')
  })

  it('marks a hidden tab, and lists 10 names and then "and N more"', () => {
    const ten = Array.from({ length: 10 }, (_, i) => ({ name: `Tab ${i + 2}`, hidden: i === 0 }))
    const t = text(render(tabs({ notImported: ten, more: 3 })))
    expect(t).toContain('not imported: “Tab 2” (hidden), “Tab 3”, ')
    expect(t).toContain('“Tab 11” and 3 more.')
  })

  it('an empty first tab: says so, and how to import another tab', () => {
    const t = text(render(tabs({ read: 'Sheet1', notImported: [{ name: 'Data', hidden: false }] }), 0))
    expect(t).toBe(
      'Only the first tab, “Sheet1”, is imported, and it has no rows. Also in this file, not imported: “Data”. ' +
        'To import another tab, move it to the front in Excel and upload the file again.',
    )
  })

  it('every tab hidden: nothing is imported', () => {
    const t = text(render(tabs({ read: null, notImported: [{ name: 'A', hidden: true }] }), 0))
    expect(t).toBe('Every tab in this file is hidden, so nothing is imported. Not imported: “A” (hidden).')
  })

  it('a tab name is plain text, never markup', () => {
    const html = render(tabs({ notImported: [{ name: '<img src=x onerror=alert(1)>', hidden: false }] }))
    expect(html).not.toContain('<img')
    expect(html).toContain('&lt;img src=x onerror=alert(1)&gt;')
  })

  it('says plainly when a tab was cut at the row limit', () => {
    const html = render(tabs({ read: 'Data', rowLimit: 100_000 }), 99_999)
    expect(text(html)).toBe(
      "Only rows 1 to 100,000 of “Data” were read. The rest of that tab won't be imported; to import it, upload those rows as a separate file.",
    )
    expect(html).toContain('data-testid="row-limit-note"')
  })
})
