import { describe, it, expect } from 'vitest'
import { createElement as h } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { DestinationStep } from '@/app/imports/DestinationStep'
import {
  DESTINATION_FIELDS,
  choiceProblem,
  destinationFormFields,
  destinationJson,
  type DestinationChoice,
} from '@/lib/core-data/importer/destination-form'
import { NAME_LENGTH_ERROR } from '@/lib/core-data/lists/rules'
import type { ListDTO } from '@/lib/core-data/lists/types'

// Brief 45 PR F — the first step of an upload: "Where should these people
// go?" [brief §5.7]: an existing list (a picker grouped by folder, archived
// lists left out) or a new list (a name, and a folder or "No folder"). The
// name follows the lists API's own rules and messages (PR A rules.ts); the
// server checks it again before anything is uploaded. Rendered statically.

const folders = [
  { id: 'f_exp', name: 'Expireds' },
  { id: 'f_off', name: 'Off-market' },
  { id: 'f_empty', name: 'Empty folder' },
]
const list = (id: string, name: string, folderId: string | null, extra: Partial<ListDTO> = {}): ListDTO => ({
  id, name, folderId, source: 'manual', sortOrder: 0, archivedAt: null, memberCount: 3, createdAt: '2026-10-18T12:00:00.000Z', ...extra,
})
const lists = [
  list('l_1', 'Expireds – Oct 2026', 'f_exp', { memberCount: 412 }),
  list('l_2', 'Brownstones likely to sell', 'f_off', { memberCount: 1102 }),
  list('l_3', 'Referrals', null, { memberCount: 1 }),
  list('l_4', 'Old expireds', 'f_exp', { archivedAt: '2026-09-01T00:00:00.000Z' }),
]

function render(value: DestinationChoice, over: Record<string, unknown> = {}) {
  return renderToStaticMarkup(h(DestinationStep, { folders, lists, value, onChange: () => {}, ...over }))
}
const decode = (s: string) => s.replace(/&#x27;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, '&')
const text = (html: string) => decode(html.replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ')

describe('DestinationStep: render', () => {
  it('asks where the people go, before anything else', () => {
    const html = render({ mode: 'list', listId: '' })
    expect(text(html)).toContain('Where should these people go?')
    expect(text(html)).toContain('An existing list')
    expect(text(html)).toContain('A new list')
  })

  it('the existing-list picker is grouped by folder in sidebar order, lists outside folders last, archived lists left out', () => {
    const html = decode(render({ mode: 'list', listId: 'l_2' }))
    const groups = [...html.matchAll(/<optgroup label="([^"]+)">([\s\S]*?)<\/optgroup>/g)].map((m) => [m[1], [...m[2].matchAll(/<option[^>]*>([^<]*)<\/option>/g)].map((o) => o[1])])
    expect(groups).toEqual([
      ['Expireds', ['Expireds – Oct 2026 · 412 people']],
      ['Off-market', ['Brownstones likely to sell · 1,102 people']],
      ['Not in a folder', ['Referrals · 1 person']],
    ])
    expect(html).not.toContain('Old expireds')
    expect(html).not.toContain('Empty folder') // a folder with no active list has nothing to pick
    expect(html).toMatch(/<option value="l_2" selected="">/)
  })

  it('a new list: its name, and a folder or "No folder" (the default)', () => {
    const html = decode(render({ mode: 'new', name: 'Expireds – Nov 2026', folderId: 'f_exp' }))
    expect(html).toMatch(/<input[^>]*value="Expireds – Nov 2026"/)
    const options = [...html.matchAll(/<select[^>]*id="new-list-folder"[^>]*>([\s\S]*?)<\/select>/g)][0]?.[1] ?? ''
    expect([...options.matchAll(/<option[^>]*>([^<]*)<\/option>/g)].map((o) => o[1])).toEqual(['No folder', 'Expireds', 'Off-market', 'Empty folder'])
    expect(options).toMatch(/<option value="f_exp" selected="">/)
    expect(decode(render({ mode: 'new', name: '', folderId: '' }))).toMatch(/<option value="" selected="">No folder<\/option>/)
  })

  it('with no lists yet, "An existing list" is greyed out and says why', () => {
    const html = render({ mode: 'new', name: '', folderId: '' }, { lists: [] })
    expect(text(html)).toContain('No lists yet. Name a new one below.')
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*value="list"|<button[^>]*value="list"[^>]*disabled=""/)
  })

  it("shows the API's plain-English refusal where the choice is made", () => {
    const html = render({ mode: 'new', name: 'Referrals', folderId: '' }, { error: 'A list named "Referrals" is already outside folders.' })
    expect(decode(html)).toMatch(/<p[^>]*role="alert"[^>]*>A list named "Referrals" is already outside folders\.<\/p>/)
  })
})

describe('DestinationStep: validation before anything is sent', () => {
  it('an existing list must be picked', () => {
    expect(choiceProblem({ mode: 'list', listId: '' })).toBe('Pick a list, or choose "A new list".')
    expect(choiceProblem({ mode: 'list', listId: 'l_1' })).toBeNull()
  })

  it("a new list's name follows the lists API's own rule and message (PR A)", () => {
    expect(choiceProblem({ mode: 'new', name: '   ', folderId: '' })).toBe(NAME_LENGTH_ERROR)
    expect(choiceProblem({ mode: 'new', name: 'x'.repeat(61), folderId: '' })).toBe(NAME_LENGTH_ERROR)
    expect(choiceProblem({ mode: 'new', name: 'Line\nbreak', folderId: '' })).toMatch(/line breaks/)
    expect(choiceProblem({ mode: 'new', name: ' Expireds – Oct 2026 ', folderId: '' })).toBeNull()
  })

  it('travels as form fields with the upload, and as JSON for the check', () => {
    expect(destinationFormFields({ mode: 'list', listId: 'l_1' })).toEqual([[DESTINATION_FIELDS.listId, 'l_1']])
    expect(destinationFormFields({ mode: 'new', name: 'Expireds', folderId: '' })).toEqual([
      [DESTINATION_FIELDS.newListName, 'Expireds'],
      [DESTINATION_FIELDS.newListFolderId, ''],
    ])
    expect(destinationJson({ mode: 'list', listId: 'l_1' })).toEqual({ listId: 'l_1' })
    expect(destinationJson({ mode: 'new', name: 'Expireds', folderId: '' })).toEqual({ newList: { name: 'Expireds', folderId: null } })
    expect(destinationJson({ mode: 'new', name: 'Expireds', folderId: 'f_exp' })).toEqual({ newList: { name: 'Expireds', folderId: 'f_exp' } })
  })
})

describe('DestinationStep: when the lists failed to load (PR F review)', () => {
  it('does not say "No lists yet" when the lists could not be loaded', () => {
    const v: DestinationChoice = { mode: 'new', name: '', folderId: '' }
    expect(text(renderToStaticMarkup(h(DestinationStep, { folders: [], lists: [], value: v, onChange: () => {}, loadFailed: true })))).not.toContain('No lists yet')
    expect(text(renderToStaticMarkup(h(DestinationStep, { folders: [], lists: [], value: v, onChange: () => {} })))).toContain('No lists yet. Name a new one below.')
  })
})
