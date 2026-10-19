import { describe, it, expect } from 'vitest'
import { createElement as h } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { EditLeadButton, LeadEditFormView, LeadEditMode } from '@/app/leads/[id]/LeadEdit'
import { draftFromInitial, type LeadEditInitial } from '@/app/leads/[id]/lead-edit-state'
import { ActivityTimeline } from '@/app/leads/[id]/ActivityTimeline'
import { SHORTCUT_GROUPS } from '@/components/shell/ShortcutsSheet'

// Brief 50 PR 5 — the lead page's Edit mode (item 6.5) as it renders: the five
// fields, DealFlow's values named as not editable here, opted-out numbers and
// emails shown but not removable, plain errors, and the keys. Plus the
// timeline's "Edited" entry and the shortcuts sheet. Made-up data only.

const decode = (s: string) => s.replace(/&#x27;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, '&').replace(/&gt;/g, '>')
const text = (html: string) => decode(html.replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim()
const count = (html: string, re: RegExp) => (html.match(re) ?? []).length

const initial: LeadEditInitial = {
  leadId: 'lead1',
  displayName: 'Test Owner 1',
  statusLabel: 'New',
  primaryAddressFull: '1 Example St, Brooklyn, NY',
  contacts: [
    {
      id: 'c1',
      displayName: 'Test Owner 1',
      phones: [
        { id: 'p1', phone: '+12125550101', locked: false },
        { id: 'p2', phone: '+12125550102', locked: true },
      ],
      emails: [
        { id: 'e1', email: 'test.owner@example.com', locked: false },
        { id: 'e2', email: 'optout@example.com', locked: true },
      ],
    },
  ],
}

const noop = () => {}
const renderForm = (over: Partial<Parameters<typeof LeadEditFormView>[0]> = {}) =>
  renderToStaticMarkup(
    h(LeadEditFormView, {
      draft: draftFromInitial(initial),
      statusOptions: ['New', 'Contacted', 'Warm'],
      saving: false,
      error: null,
      fieldErrors: {},
      onChange: noop,
      onSave: noop,
      onCancel: noop,
      ...over,
    }),
  )

describe('the edit form', () => {
  it('has the name, status and address, filled in, with labels', () => {
    const html = renderForm()
    for (const label of ['Name', 'Status', 'Address']) expect(text(html)).toContain(label)
    expect(html).toMatch(/<input[^>]*value="Test Owner 1"/)
    expect(html).toMatch(/<input[^>]*value="New"[^>]*list="|<input[^>]*list="[^"]*"[^>]*value="New"/)
    expect(html).toMatch(/<input[^>]*value="1 Example St, Brooklyn, NY"/)
    // The status field suggests the statuses already in use.
    expect(html).toMatch(/<datalist[^>]*>.*<option value="Contacted">.*<\/datalist>/s)
    expect(html).toMatch(/<form[^>]*aria-label="Edit lead"/)
  })

  it('lists each contact\'s phones and emails; opted-out ones are shown but can\'t be removed', () => {
    const html = renderForm()
    expect(text(html)).toMatch(/Phones/)
    expect(text(html)).toMatch(/Emails/)
    expect(html).toMatch(/value="\+12125550101"/)
    expect(html).toMatch(/value="test\.owner@example\.com"/)
    expect(text(html)).toMatch(/Texts blocked/)
    expect(text(html)).toMatch(/Opted out/)
    // Only the two unlocked rows get a remove button.
    expect(count(html, /aria-label="Remove this phone"/)).toBe(1)
    expect(count(html, /aria-label="Remove this email"/)).toBe(1)
    expect(html).toMatch(/<input[^>]*readOnly=""[^>]*value="\+12125550102"|<input[^>]*value="\+12125550102"[^>]*readOnly=""/)
    expect(text(html)).toMatch(/Add phone/)
    expect(text(html)).toMatch(/Add email/)
  })

  it('says DealFlow\'s values aren\'t edited here', () => {
    expect(text(renderForm())).toMatch(/come from DealFlow and can't be changed here/)
  })

  it('shows Save and Cancel with their keys', () => {
    const html = renderForm()
    expect(text(html)).toMatch(/Save/)
    expect(text(html)).toMatch(/Cancel/)
    expect(html).toMatch(/aria-keyshortcuts="Control\+Enter Meta\+Enter"/)
    expect(html).toMatch(/aria-keyshortcuts="Escape"/)
    expect(html).toMatch(/<kbd[^>]*>Esc<\/kbd>/)
  })

  it('shows the API\'s plain error, and a field\'s error next to that field', () => {
    const html = renderForm({
      error: '"555-0123" isn\'t a phone number.',
      fieldErrors: { p1: '"555-0123" isn\'t a phone number.' },
    })
    expect(html).toMatch(/role="alert"/)
    expect(text(html)).toContain(`"555-0123" isn't a phone number.`)
    expect(html).toMatch(/aria-invalid="true"[^>]*value="\+12125550101"|value="\+12125550101"[^>]*aria-invalid="true"/)
  })

  it('says when a lead has no contact to hold phones and emails', () => {
    const html = renderForm({ draft: draftFromInitial({ ...initial, contacts: [] }) })
    expect(text(html)).toMatch(/no contact/i)
    expect(text(html)).not.toMatch(/Add phone/)
  })
})

describe('the Edit button', () => {
  it('names its key', () => {
    const html = renderToStaticMarkup(h(LeadEditMode, { initial, statusOptions: [] }, h(EditLeadButton)))
    expect(text(html)).toMatch(/Edit/)
    expect(html).toMatch(/aria-keyshortcuts="e"/)
  })
})

describe('the timeline', () => {
  it('shows an edit as "Edited" and each change on its own line', () => {
    const at = '2026-10-19T19:42:00.000Z'
    const html = renderToStaticMarkup(
      h(ActivityTimeline, {
        items: [{ id: 'a1', type: 'Edit', activityAt: at, bodyText: 'Name changed\nPhone added (…0123)\nStatus: New → Contacted' }],
      }),
    )
    const li = [...html.matchAll(/<li[^>]*>([\s\S]*?)<\/li>/g)].map((m) => m[1])
    expect(text(html.replace(/<time[\s\S]*?<\/time>/, ''))).toBe('Edited Name changed Phone added (…0123) Status: New → Contacted')
    // The three changes are three list items under the entry.
    expect(li.length).toBeGreaterThanOrEqual(3)
    expect(html).toMatch(new RegExp(`<time[^>]*dateTime="${at}"`, 'i'))
  })
})

describe('the shortcuts sheet', () => {
  it('lists the lead page\'s edit keys', () => {
    const lead = SHORTCUT_GROUPS.find((g) => g.title === 'Lead page')
    expect(lead).toBeDefined()
    expect(lead!.items).toEqual([
      { keys: ['e'], label: 'Edit the lead (name, status, address, phones, emails)' },
      { keys: ['⌘/Ctrl', 'Enter'], label: 'Save the edit' },
      { keys: ['Esc'], label: 'Cancel the edit' },
    ])
  })
})
