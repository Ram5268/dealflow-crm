import { describe, it, expect } from 'vitest'
import { createElement as h } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import type { ColumnMapping, MappingTarget } from '@/lib/core-data/importer/ai-mapping'
import { MappingTable } from '@/app/imports/[id]/mapping-review/MappingTable'
import { DuplicatePreview } from '@/app/imports/[id]/mapping-review/DuplicatePreview'
import {
  duplicateHeadline,
  partialLine,
  matchLine,
  moreLine,
  unidentifiedLine,
  type DuplicatePreviewDTO,
} from '@/lib/core-data/importer/duplicate-preview-view'

// Brief 50 PR 6 (open item 6.6): the review screen, rendered statically.
//   - every column has a field picker (with "Don't import"), not fixed text;
//   - a column Ryan changed says so, and one the AI got muddled is flagged;
//   - before the commit: how many rows look like people already in the CRM,
//     with a short list (name and the last 4 digits of the phone).
// Made-up people and 555-01xx numbers only.

const col = (column: string, target: MappingTarget, sampleValues: string[] = []): ColumnMapping => ({
  column, sampleValues, target, confidence: 0.92, reasoning: '',
})
const std = (field: string) => ({ kind: 'standard_field', field }) as MappingTarget
const decode = (s: string) => s.replace(/&#x27;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, '&')
const text = (html: string) => decode(html.replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ')

const ai = [
  col('Contact ID', { kind: 'new_custom_field', name: 'Contact ID', type: 'text' }, ['M_1', 'M_2']),
  col('Full Name', std('Lead.name'), ['Test Owner One']),
  col('Phone', std('ContactPhone.phone'), ['212-555-0171']),
  col('Notes', { kind: 'ignore' }),
]
const aiTargets = Object.fromEntries(ai.map((c) => [c.column, c.target]))

function renderTable(mapping: ColumnMapping[], over: Record<string, unknown> = {}) {
  return renderToStaticMarkup(
    h(MappingTable, { mapping, aiTargets, customFields: [{ definitionId: 'cf_est', name: 'Estimated Value', type: 'number' }], coerced: [], manual: false, onChange: () => {}, ...over }),
  )
}

describe('MappingTable', () => {
  it('a field picker for every column, set to the current choice, each offering "Don\'t import"', () => {
    const html = renderTable(ai)
    expect(html.match(/<select/g)).toHaveLength(4)
    for (const c of ai) expect(html).toContain(`aria-label="Field for the column ${c.column}"`)
    expect(html.match(/<option value="ignore"/g)).toHaveLength(4)
    expect(html).toMatch(/<option value="std:Lead.name" selected="">Owner name<\/option>/)
    expect(html).toMatch(/<option value="new" selected="">New custom field &quot;Contact ID&quot;<\/option>/)
    expect(html).toMatch(/<option value="ignore" selected="">Don&#x27;t import<\/option>/)
    expect(text(html)).toContain('Custom field: Estimated Value')
  })

  it('keeps one row per column, with the column name in a cell of its own, and its samples', () => {
    const html = renderTable(ai)
    expect(html.match(/<tbody[\s\S]*<\/tbody>/)![0].match(/<tr/g)).toHaveLength(4)
    expect(html).toContain('>Full Name</td>')
    expect(text(html)).toContain('M_1, M_2')
  })

  it("a column Ryan changed is marked, and shows no AI confidence; the others show the AI's", () => {
    const html = renderTable(ai.map((c) => (c.column === 'Contact ID' ? { ...c, target: std('Lead.mojoId') } : c)))
    expect(text(html)).toContain('Changed')
    expect(html.match(/Changed/g)).toHaveLength(1)
    expect(text(html)).toContain('92%')
  })

  it('a column whose AI answer had to be rewritten asks Ryan to check it', () => {
    expect(text(renderTable(ai, { coerced: ['Notes'] }))).toContain("Check this one: the AI's answer for it was unclear")
  })

  it('a mapping started by hand (no AI) shows no confidence at all', () => {
    const html = renderTable(ai.map((c) => ({ ...c, target: { kind: 'ignore' } as MappingTarget, confidence: 0 })), { manual: true })
    expect(text(html)).not.toContain('%')
    expect(text(html)).not.toContain('Changed')
  })
})

const preview = (over: Partial<DuplicatePreviewDTO> = {}): DuplicatePreviewDTO => ({
  totalRows: 412,
  checkedRows: 412,
  existing: 2,
  unidentified: 0,
  matches: [
    { row: 3, name: 'Test Owner One', phoneLast4: '0171', leadId: 'lead_1', leadName: 'Test Owner One', via: 'mojo' },
    { row: 9, name: 'Test Owner Two', phoneLast4: null, leadId: 'lead_2', leadName: 'T. Owner Two', via: 'name-address' },
  ],
  ...over,
})

describe('the "already in your CRM" words', () => {
  it('a count of rows, and what happens to them', () => {
    expect(duplicateHeadline(preview())).toBe(
      "2 of 412 rows look like people already in your CRM. They'll be merged into those leads, not added again.",
    )
    expect(duplicateHeadline(preview({ existing: 1, totalRows: 1 }))).toBe(
      "1 of 1 row looks like someone already in your CRM. It'll be merged into that lead, not added again.",
    )
    expect(duplicateHeadline(preview({ existing: 0, matches: [], totalRows: 1200 }))).toBe('None of the 1,200 rows match someone already in your CRM.')
  })

  it('each listed row: its name, the last 4 digits of its phone, and the lead it merges into, and why', () => {
    expect(matchLine(preview().matches[0])).toBe('Row 3: Test Owner One, phone ending 0171 → Test Owner One (same Mojo ID)')
    expect(matchLine(preview().matches[1])).toBe('Row 9: Test Owner Two → T. Owner Two (same name and address)')
    expect(matchLine({ ...preview().matches[0], via: 'phone' })).toContain('(same phone)')
  })

  it('the rest are counted, and rows that can\'t be matched are called out', () => {
    expect(moreLine(preview({ existing: 25 }))).toBe('…and 23 more.')
    expect(moreLine(preview())).toBeNull()
    expect(unidentifiedLine(1)).toBe('1 row has no Mojo ID, phone, name or address, so it will be skipped.')
    expect(unidentifiedLine(3)).toBe('3 rows have no Mojo ID, phone, name or address, so they will be skipped.')
    expect(unidentifiedLine(0)).toBeNull()
  })
})

describe('a check that stopped early', () => {
  it('says how far it got only when it stopped before the end', () => {
    expect(partialLine(preview())).toBeNull()
    expect(partialLine(preview({ totalRows: 9000, checkedRows: 2500 }))).toBe(
      'Checked the first 2,500 of 9,000 rows; the counts above are for those rows only. The import itself checks every row.',
    )
  })
})

describe('DuplicatePreview', () => {
  const render = (state: Parameters<typeof DuplicatePreview>[0]['state']) => text(renderToStaticMarkup(h(DuplicatePreview, { state })))

  it('while checking, then the result with its short list and links to the leads', () => {
    expect(render({ status: 'checking' })).toContain('Checking which rows are people already in your CRM')
    const html = renderToStaticMarkup(h(DuplicatePreview, { state: { status: 'done', preview: preview({ existing: 25, unidentified: 1 }) } }))
    expect(text(html)).toContain('25 of 412 rows look like people already in your CRM')
    expect(text(html)).toContain('Row 3: Test Owner One, phone ending 0171')
    expect(text(html)).toContain('…and 23 more.')
    expect(text(html)).toContain('1 row has no Mojo ID')
    expect(html).toContain('href="/leads/lead_1"')
  })

  it("says plainly when it couldn't check, and that the commit still merges the same way", () => {
    expect(render({ status: 'error', error: 'Network down' })).toContain("Couldn't check for people already in your CRM")
    expect(render({ status: 'error', error: 'Network down' })).toContain('still merges them')
  })

  it('nothing to show until a column can match rows', () => {
    expect(render({ status: 'blocked' })).toBe('')
  })
})
