import { describe, it, expect } from 'vitest'
import { createElement as h } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import {
  SAME_LEAD_ADDED_BY,
  lockedPhone,
  numbersToPutOnDoNotContact,
  phonesOnDoNotContact,
  putOnDoNotContact,
} from '@/lib/core-data/leads/opt-out'
import { DO_NOT_CONTACT_LABEL, TEXTS_BLOCKED_LABEL, putOnDoNotContactLine } from '@/lib/core-data/leads/edit-text'
import { draftFromInitial, leadEditInitialFrom, phoneLockLabel, type LeadForEdit } from '@/app/leads/[id]/lead-edit-state'
import { LeadEditFormView } from '@/app/leads/[id]/LeadEdit'

// Brief 50 PR 17 (the planner's review, Brief 50 Revision 2, 2026-10-23): a
// lead's phone on the Do not contact list is decided by the call checks' own
// matcher (internalDncHits) and locked on the lead page; a number added to a
// lead that has one goes on the list too, with the same reason. The list
// exists because a homeowner asked not to be contacted; nothing may contact a
// lead [Ryan]. Pure: a fake database that matches text exactly, like Postgres
// '='. Made-up numbers only (555-01xx).

const ORG = 'org_test'

type Row = { id: string; organizationId: string; phone: string; source: string; reason: string | null; addedBy: string | null; addedAt: Date }

function fakeDb(seed: Array<Partial<Row> & { phone: string }> = []) {
  let n = 0
  const rows: Row[] = seed.map((r) => ({
    id: `seed_${n++}`,
    organizationId: ORG,
    source: 'internal',
    reason: null,
    addedBy: null,
    addedAt: new Date(Date.UTC(2026, 9, 1 + n)),
    ...r,
  }))
  const calls: string[] = []
  const matches = (where: any) => (r: Row) =>
    r.organizationId === where.organizationId &&
    (where.source === undefined || r.source === where.source) &&
    (where.phone?.in === undefined || where.phone.in.includes(r.phone))
  const db = {
    dncSuppression: {
      async findUnique({ where }: any) {
        const k = where.organizationId_phone_source
        return rows.find((r) => r.organizationId === k.organizationId && r.phone === k.phone && r.source === k.source) ?? null
      },
      async findMany({ where }: any) {
        calls.push('findMany')
        return rows.filter(matches(where)).map((r) => ({ phone: r.phone }))
      },
      async findFirst({ where, orderBy }: any) {
        calls.push('findFirst')
        expect(orderBy).toEqual([{ addedAt: 'asc' }, { id: 'asc' }])
        const found = rows.filter(matches(where)).sort((a, b) => a.addedAt.getTime() - b.addedAt.getTime() || (a.id < b.id ? -1 : 1))
        return found[0] ? { reason: found[0].reason } : null
      },
      async create({ data }: any) {
        const r = { id: `dnc_${n++}`, addedAt: new Date(), reason: null, addedBy: null, ...data }
        rows.push(r)
        return r
      },
      async createMany({ data, skipDuplicates }: any) {
        calls.push('createMany')
        expect(skipDuplicates).toBe(true)
        let count = 0
        for (const d of data) {
          if (rows.some((r) => r.organizationId === d.organizationId && r.phone === d.phone && r.source === d.source)) continue
          rows.push({ id: `dnc_${n++}`, addedAt: new Date(), reason: null, addedBy: null, ...d })
          count++
        }
        return { count }
      },
    },
  }
  return { db: db as any, rows, calls }
}

describe('which of a lead\'s phones are on the Do not contact list (the call checks\' matcher)', () => {
  it('finds a phone on the internal list, as the lead stores it', async () => {
    const { db } = fakeDb([{ phone: '+13475550101' }])
    const hit = await phonesOnDoNotContact(db, ORG, ['+13475550101', '+13475550102'])
    expect([...hit]).toEqual(['+13475550101'])
  })

  it('finds it however either side was stored: an old typed form, or "+" and the 10 digits from before PR 13', async () => {
    for (const stored of ['3475550101', '13475550101', '+3475550101']) {
      const { db } = fakeDb([{ phone: stored }])
      expect([...(await phonesOnDoNotContact(db, ORG, ['+13475550101']))], stored).toEqual(['+13475550101'])
    }
    // The lead's own phone stored the old way, the opt-out canonical.
    const { db } = fakeDb([{ phone: '+13475550101' }])
    expect([...(await phonesOnDoNotContact(db, ORG, ['(347) 555-0101', '+3475550101']))].sort()).toEqual(['(347) 555-0101', '+3475550101'])
  })

  it('only the internal list of this organization counts (not a registry row, not another organization)', async () => {
    const { db } = fakeDb([
      { phone: '+13475550101', source: 'federal' },
      { phone: '+13475550102', organizationId: 'org_other' },
    ])
    expect((await phonesOnDoNotContact(db, ORG, ['+13475550101', '+13475550102'])).size).toBe(0)
  })

  it('a lead with no phones asks nothing', async () => {
    const { db, calls } = fakeDb()
    expect((await phonesOnDoNotContact(db, ORG, [])).size).toBe(0)
    expect(calls).toEqual([])
  })
})

describe('a number added to a lead that has a Do not contact number', () => {
  it('goes on the list too, with the same reason', async () => {
    const { db, rows } = fakeDb([{ phone: '+13475550101', reason: 'Asked not to be called' }])
    const follow = await numbersToPutOnDoNotContact(db, ORG, { existing: ['+13475550101', '+13475550102'], adding: ['+13475550103'] })
    expect(follow).toEqual({ phones: ['+13475550103'], reason: 'Asked not to be called' })
    await putOnDoNotContact(db, ORG, follow!, SAME_LEAD_ADDED_BY.leadEdit)
    const added = rows.find((r) => r.phone === '+13475550103')!
    // The same shape as an entry from Settings → Do not contact (addInternalDnc).
    expect(added).toMatchObject({ organizationId: ORG, phone: '+13475550103', source: 'internal', reason: 'Asked not to be called', addedBy: 'same-lead-opt-out:lead-edit' })
    // The number already on the lead isn't added by this write, so it stays as it is.
    expect(rows.some((r) => r.phone === '+13475550102')).toBe(false)
  })

  it('an opt-out with no reason gives the new entry no reason', async () => {
    const { db } = fakeDb([{ phone: '+13475550101' }])
    expect(await numbersToPutOnDoNotContact(db, ORG, { existing: ['+13475550101'], adding: ['+13475550103'] })).toEqual({
      phones: ['+13475550103'],
      reason: null,
    })
  })

  it('takes the reason of the lead\'s earliest opt-out when it has several', async () => {
    const { db } = fakeDb([
      { phone: '+13475550101', reason: 'Texted STOP later', addedAt: new Date('2026-10-20T00:00:00Z') },
      { phone: '+13475550102', reason: 'Asked first', addedAt: new Date('2026-10-02T00:00:00Z') },
    ])
    const follow = await numbersToPutOnDoNotContact(db, ORG, { existing: ['+13475550101', '+13475550102'], adding: ['+13475550104'] })
    expect(follow?.reason).toBe('Asked first')
  })

  it('a number already on the list, or already on the lead, isn\'t added again', async () => {
    const { db } = fakeDb([{ phone: '+13475550101' }, { phone: '3475550105' }])
    const follow = await numbersToPutOnDoNotContact(db, ORG, {
      existing: ['+13475550101', '+13475550102'],
      adding: ['+13475550105', '(347) 555-0102', '+13475550106', '+13475550106'],
    })
    expect(follow?.phones).toEqual(['+13475550106'])
  })

  it('a save that adds a listed number and another one to a lead with none: the other one goes on the list too', async () => {
    const { db } = fakeDb([{ phone: '+13475550107', reason: 'Asked not to be called' }])
    const follow = await numbersToPutOnDoNotContact(db, ORG, { existing: ['+13475550102'], adding: ['+13475550107', '+13475550108'] })
    expect(follow).toEqual({ phones: ['+13475550108'], reason: 'Asked not to be called' })
  })

  it('a lead with no Do not contact number is unaffected: nothing to add, and no reason looked up', async () => {
    const { db, rows, calls } = fakeDb([{ phone: '+13475550199', reason: 'someone else' }])
    expect(await numbersToPutOnDoNotContact(db, ORG, { existing: ['+13475550102'], adding: ['+13475550103'] })).toBeNull()
    expect(calls).toEqual(['findMany'])
    expect(rows).toHaveLength(1)
  })

  // Executor's follow-up (Brief 50 PR 17): a brand-new lead, e.g. from an upload.
  it('a new lead with a listed number and another: the other goes on the list too', async () => {
    const { db } = fakeDb([{ phone: '+13475550185', reason: 'Asked not to be called' }])
    expect(await numbersToPutOnDoNotContact(db, ORG, { existing: [], adding: ['+13475550185', '+13475550186'] })).toEqual({
      phones: ['+13475550186'],
      reason: 'Asked not to be called',
    })
  })

  it('a new lead with a single number asks nothing: there is no other number to put on the list', async () => {
    const { db, calls } = fakeDb([{ phone: '+13475550185' }])
    expect(await numbersToPutOnDoNotContact(db, ORG, { existing: [], adding: ['+13475550185'] })).toBeNull()
    expect(await numbersToPutOnDoNotContact(db, ORG, { existing: [], adding: ['+13475550185', '(347) 555-0185'] })).toBeNull()
    expect(calls).toEqual([])
  })

  it('a write that adds nothing asks nothing', async () => {
    const { db, calls } = fakeDb([{ phone: '+13475550101' }])
    expect(await numbersToPutOnDoNotContact(db, ORG, { existing: ['+13475550101'], adding: [] })).toBeNull()
    expect(calls).toEqual([])
  })

  it('names each way in: the lead edit, a new contact, an upload', () => {
    expect(SAME_LEAD_ADDED_BY).toEqual({
      leadEdit: 'same-lead-opt-out:lead-edit',
      newContact: 'same-lead-opt-out:contacts-api',
      upload: 'same-lead-opt-out:import',
    })
  })
})

describe('what a delete refuses', () => {
  it('a number on the list, or with texts blocked; a lead with neither is fine', async () => {
    const { db } = fakeDb([{ phone: '+13475550101' }])
    expect(await lockedPhone(db, ORG, [{ phone: '+13475550102', outboundSmsBlocked: false }, { phone: '+13475550101', outboundSmsBlocked: false }])).toEqual({
      phone: '+13475550101',
      label: DO_NOT_CONTACT_LABEL,
    })
    expect(await lockedPhone(db, ORG, [{ phone: '+13475550102', outboundSmsBlocked: true }])).toEqual({ phone: '+13475550102', label: TEXTS_BLOCKED_LABEL })
    expect(await lockedPhone(db, ORG, [{ phone: '+13475550102', outboundSmsBlocked: false }])).toBeNull()
    expect(await lockedPhone(db, ORG, [])).toBeNull()
  })
})

describe('the history line', () => {
  it('shows only the last 4 digits', () => {
    expect(putOnDoNotContactLine('+13475550103')).toBe('Put on Do not contact (…0103), like another number on this lead')
    expect(putOnDoNotContactLine('+13475550103', 'contact')).toBe('A new contact\'s phone put on Do not contact (…0103), like another number on this lead')
    expect(putOnDoNotContactLine('+13475550103', 'upload')).toBe('A phone from an upload put on Do not contact (…0103), like another number on this lead')
    for (const via of [undefined, 'contact', 'upload'] as const) expect(putOnDoNotContactLine('+13475550103', via)).not.toMatch(/347|555/)
  })
})

describe('the lead page and its Edit form', () => {
  const lead: LeadForEdit = {
    id: 'lead1',
    displayName: 'Test Owner 1',
    statusLabel: null,
    primaryAddressFull: '1 Example St, Brooklyn, NY',
    contacts: [
      {
        id: 'c1',
        displayName: 'Test Owner 1',
        createdAt: new Date('2026-10-01T00:00:00Z'),
        phones: [
          { id: 'p1', phone: '+13475550101', phoneFormatted: null, outboundSmsBlocked: false, isPrimary: true, createdAt: new Date('2026-10-01T00:00:00Z') },
          { id: 'p2', phone: '+13475550102', phoneFormatted: '(347) 555-0102', outboundSmsBlocked: false, isPrimary: false, createdAt: new Date('2026-10-02T00:00:00Z') },
          { id: 'p3', phone: '+13475550103', phoneFormatted: null, outboundSmsBlocked: true, isPrimary: false, createdAt: new Date('2026-10-03T00:00:00Z') },
        ],
        emails: [{ id: 'e1', email: 'test.owner@example.com', isUnsubscribed: false, isPrimary: true }],
      },
    ],
  }

  it('a phone on the list shows "Do not contact"; "texts blocked" still locks; the rest stay editable', () => {
    expect(phoneLockLabel({ phone: '+13475550101', outboundSmsBlocked: false }, new Set(['+13475550101']))).toBe('Do not contact')
    expect(phoneLockLabel({ phone: '+13475550101', outboundSmsBlocked: true }, new Set(['+13475550101']))).toBe('Do not contact')
    expect(phoneLockLabel({ phone: '+13475550103', outboundSmsBlocked: true }, new Set())).toBe('Texts blocked')
    expect(phoneLockLabel({ phone: '+13475550102', outboundSmsBlocked: false }, new Set(['+13475550101']))).toBeNull()

    const initial = leadEditInitialFrom(lead, new Set(['+13475550101']))
    expect(initial.contacts[0].phones).toEqual([
      { id: 'p1', phone: '+13475550101', locked: true, lockLabel: 'Do not contact' },
      { id: 'p2', phone: '(347) 555-0102', locked: false },
      { id: 'p3', phone: '+13475550103', locked: true, lockLabel: 'Texts blocked' },
    ])
  })

  it('a lead with no opt-out is unaffected', () => {
    const initial = leadEditInitialFrom({ ...lead, contacts: [{ ...lead.contacts[0], phones: lead.contacts[0].phones.slice(0, 2) }] }, new Set())
    expect(initial.contacts[0].phones.map((p) => p.locked)).toEqual([false, false])
  })

  it('the form shows "Do not contact" on that number, read-only and with no remove button', () => {
    const html = renderToStaticMarkup(
      h(LeadEditFormView, {
        draft: draftFromInitial(leadEditInitialFrom(lead, new Set(['+13475550101']))),
        statusOptions: [],
        saving: false,
        error: null,
        fieldErrors: {},
        onChange: () => {},
        onSave: () => {},
        onCancel: () => {},
      }),
    )
    const text = html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ')
    expect(text).toContain('Do not contact')
    expect(text).toContain('Texts blocked')
    expect((html.match(/aria-label="Remove this phone"/g) ?? []).length).toBe(1)
    expect(html).toMatch(/<input[^>]*readOnly=""[^>]*value="\+13475550101"|<input[^>]*value="\+13475550101"[^>]*readOnly=""/)
    // It says a number added to such a lead goes on the list too.
    expect(text).toMatch(/goes on the Do not contact list too/)
  })
})
