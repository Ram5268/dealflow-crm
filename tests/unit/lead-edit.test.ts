import { describe, it, expect } from 'vitest'
import {
  LEAD_EDIT_ACTIVITY_TYPE,
  addressChange,
  editEntryLines,
  emailAdded,
  emailChanged,
  emailRemoved,
  maskEmail,
  phoneAdded,
  phoneChanged,
  phoneLast4,
  phoneRemoved,
  statusChange,
} from '@/lib/core-data/leads/edit-text'
import { DEALFLOW_LEAD_FIELDS, isStandardUsPhone, parseLeadEdit } from '@/lib/core-data/leads/edit'
import { HttpError } from '@/lib/shared/http'
import {
  buildLeadEditPayload,
  draftFromInitial,
  leadEditKeyAction,
  type LeadEditInitial,
} from '@/app/leads/[id]/lead-edit-state'

// Brief 50 PR 5 — the pure pieces of "edit a lead": the timeline wording, the
// request check, what the form sends, and its keys. Made-up data; phones in
// 555-01xx.

describe('timeline wording', () => {
  it('uses its own entry type', () => {
    expect(LEAD_EDIT_ACTIVITY_TYPE).toBe('Edit')
  })

  it('shows only the last 4 digits of a phone [engineering precaution]', () => {
    expect(phoneLast4('+12125550123')).toBe('0123')
    expect(phoneLast4('(212) 555-0123')).toBe('0123')
    expect(phoneLast4('12345')).toBeNull() // too short: 4 digits would be most of it
    expect(phoneAdded('+12125550123')).toBe('Phone added (…0123)')
    expect(phoneRemoved('+12125550101')).toBe('Phone removed (…0101)')
    expect(phoneChanged('+12125550102', '+12125550145')).toBe('Phone changed (…0102 → …0145)')
    expect(phoneRemoved('12345')).toBe('Phone removed')
    for (const s of [phoneAdded('+12125550123'), phoneChanged('+12125550102', '+12125550145')]) expect(s).not.toMatch(/555|212/)
  })

  it('shows an email as its first letter and domain', () => {
    expect(maskEmail('test.owner@example.com')).toBe('t…@example.com')
    expect(maskEmail('no-at-sign')).toBe('…')
    expect(emailAdded('test.owner@example.com')).toBe('Email added (t…@example.com)')
    expect(emailRemoved('gone@example.org')).toBe('Email removed (g…@example.org)')
    expect(emailChanged('old@example.com', 'new@example.com')).toBe('Email changed (o…@example.com → n…@example.com)')
  })

  it('says how the status and address changed', () => {
    expect(statusChange('New', 'Contacted')).toBe('Status: New → Contacted')
    expect(statusChange(null, 'Contacted')).toBe('Status set to Contacted')
    expect(statusChange('New', null)).toBe('Status cleared (was New)')
    expect(addressChange('1 Example St', '2 Example St')).toBe('Address changed')
    expect(addressChange(null, '2 Example St')).toBe('Address added')
    expect(addressChange('1 Example St', null)).toBe('Address removed')
  })

  it('splits an entry into its lines', () => {
    expect(editEntryLines('Name changed\nPhone added (…0123)\n')).toEqual(['Name changed', 'Phone added (…0123)'])
    expect(editEntryLines(null)).toEqual([])
  })
})

describe('the request check', () => {
  const fail = (raw: unknown) => {
    try {
      parseLeadEdit(raw)
    } catch (err) {
      expect(err).toBeInstanceOf(HttpError)
      return err as HttpError
    }
    throw new Error('expected a refusal')
  }

  it('accepts the five fields and trims them', () => {
    expect(parseLeadEdit({ displayName: '  Test Owner  ', statusLabel: ' Warm ', primaryAddressFull: '  ' })).toEqual({
      displayName: 'Test Owner',
      statusLabel: 'Warm',
      primaryAddressFull: null,
    })
    expect(parseLeadEdit({ statusLabel: null })).toEqual({ statusLabel: null })
    expect(parseLeadEdit({ contacts: [{ id: 'c1', phones: [{ id: 'p1' }, { phone: '212-555-0123' }], emails: [] }] })).toEqual({
      contacts: [{ id: 'c1', phones: [{ id: 'p1' }, { phone: '212-555-0123' }], emails: [] }],
    })
  })

  it('refuses DealFlow\'s values by name', () => {
    expect(DEALFLOW_LEAD_FIELDS).toEqual(
      expect.arrayContaining(['priorityScore', 'topMatchFit', 'captureStatus', 'matchReason', 'dealflowDeepLink', 'dealflowSignalSyncedAt', 'mojoId']),
    )
    const err = fail({ priorityScore: 5 })
    expect(err.status).toBe(400)
    expect(err.message).toMatch(/DealFlow/)
  })

  it('refuses anything else in plain words', () => {
    expect(fail({ timezone: 'America/New_York' }).message).toMatch(/Only the name, status, address, phones and emails/)
    expect(fail('not an object').status).toBe(400)
    const blank = fail({ displayName: ' ' })
    expect(blank.message).toBe("The name can't be blank.")
    expect(blank.extra).toEqual({ field: 'displayName' })
    expect(fail({ displayName: 'x'.repeat(201) }).message).toMatch(/too long/)
    expect(fail({ contacts: [{ id: 'c1', phones: [{}] }] }).status).toBe(400)
  })

  it('knows the standard US form', () => {
    expect(isStandardUsPhone('+12125550123')).toBe(true)
    expect(isStandardUsPhone('+9175550123')).toBe(false)
    expect(isStandardUsPhone('2125550123')).toBe(false)
  })
})

describe('what the form sends', () => {
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
        emails: [{ id: 'e1', email: 'test.owner@example.com', locked: false }],
      },
    ],
  }

  it('sends nothing when nothing changed', () => {
    expect(buildLeadEditPayload(initial, draftFromInitial(initial)).payload).toBeNull()
  })

  it('sends only the fields that changed; untouched numbers go by id only', () => {
    const draft = draftFromInitial(initial)
    draft.displayName = 'Test Owner One'
    draft.contacts[0].phones[0].value = '212-555-0145'
    draft.contacts[0].phones.push({ key: 'new1', value: '212-555-0146', locked: false })
    draft.contacts[0].phones.push({ key: 'new2', value: '   ', locked: false }) // a blank new row is dropped
    const { payload, fieldKeys } = buildLeadEditPayload(initial, draft)
    expect(payload).toEqual({
      displayName: 'Test Owner One',
      contacts: [
        {
          id: 'c1',
          phones: [{ id: 'p1', phone: '212-555-0145' }, { id: 'p2' }, { phone: '212-555-0146' }],
          emails: [{ id: 'e1' }],
        },
      ],
    })
    // A refusal for the request's third phone points at the row the user typed.
    expect(fieldKeys['contacts.c1.phones.2']).toBe('new1')
    expect(fieldKeys['displayName']).toBe('displayName')
  })

  it('a removed or emptied row is left out (that removes it); a blank status or address is sent as cleared', () => {
    const draft = draftFromInitial(initial)
    draft.contacts[0].emails[0].value = ''
    draft.statusLabel = ''
    draft.primaryAddressFull = ' '
    const { payload } = buildLeadEditPayload(initial, draft)
    expect(payload).toEqual({
      statusLabel: null,
      primaryAddressFull: null,
      contacts: [{ id: 'c1', phones: [{ id: 'p1' }, { id: 'p2' }], emails: [] }],
    })
  })
})

describe('the keys', () => {
  const key = (k: string, mods: Partial<{ metaKey: boolean; ctrlKey: boolean; altKey: boolean; shiftKey: boolean; repeat: boolean }> = {}) => ({
    key: k, metaKey: false, ctrlKey: false, altKey: false, shiftKey: false, ...mods,
  })
  const page = { editing: false, editable: false, inDialog: false, onPage: true }

  it('"e" starts editing, but not while typing, in a dialog, or with a modifier', () => {
    expect(leadEditKeyAction(key('e'), page)).toBe('edit')
    expect(leadEditKeyAction(key('e'), { ...page, editable: true })).toBeNull()
    expect(leadEditKeyAction(key('e'), { ...page, inDialog: true })).toBeNull()
    expect(leadEditKeyAction(key('e'), { ...page, onPage: false })).toBeNull()
    expect(leadEditKeyAction(key('e', { metaKey: true }), page)).toBeNull()
    expect(leadEditKeyAction(key('e', { repeat: true }), page)).toBeNull()
    expect(leadEditKeyAction(key('e'), { ...page, editing: true })).toBeNull()
  })

  it('while editing: Esc cancels and Ctrl/⌘+Enter saves, even from a text field', () => {
    const editing = { ...page, editing: true, editable: true }
    expect(leadEditKeyAction(key('Escape'), editing)).toBe('cancel')
    expect(leadEditKeyAction(key('Enter', { metaKey: true }), editing)).toBe('save')
    expect(leadEditKeyAction(key('Enter', { ctrlKey: true }), editing)).toBe('save')
    expect(leadEditKeyAction(key('Enter'), editing)).toBeNull()
    expect(leadEditKeyAction(key('Escape'), { ...editing, inDialog: true })).toBeNull()
  })
})
