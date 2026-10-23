import 'dotenv/config'
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { NextRequest } from 'next/server'
import { prisma } from '@/lib/prisma'
import { PUT as updateLead } from '@/app/api/leads/[id]/route'
import { applyLeadEdit } from '@/lib/core-data/leads/edit'
import { mainIsTestDb } from '../setup/live-guard'

// Brief 50 PR 5 — editing a lead from its page (item 6.5): the name, status,
// address, phones and emails, through PUT /api/leads/[id]. Each save that
// changes something writes ONE timeline entry (an Activity of type 'Edit')
// that says in plain words what changed, with only a phone's last 4 digits.
// DealFlow's values can't be changed here. Brief 50 PR 17 (the planner's
// review, Brief 50 Revision 2, 2026-10-23): a number on the Do not contact list
// can't be removed or changed, and a number added to a lead that has one goes
// on the list too, in the same save. Made-up people only; phones in 555-01xx.
const enabled = mainIsTestDb() // Brief 41: refuses a live DATABASE_URL_MAIN
const TAG = `B50PR5_${Date.now().toString(36)}`

interface Res {
  status: number
  body: { error?: string; field?: string; changes?: string[]; lead?: Record<string, unknown> }
}

async function put(leadId: string, body: unknown): Promise<Res> {
  const req = new NextRequest(new URL(`/api/leads/${leadId}`, 'http://localhost'), {
    method: 'PUT',
    body: JSON.stringify(body),
    headers: { 'content-type': 'application/json' },
  })
  const res = await updateLead(req, { params: Promise.resolve({ id: leadId }) })
  return { status: res.status, body: await res.json() }
}

describe.runIf(enabled)('editing a lead (PUT /api/leads/[id])', () => {
  let orgId: string
  let otherOrg: string
  let n = 0

  async function makeLead(opts: {
    org?: string
    statusLabel?: string | null
    statusId?: string | null
    address?: string | null
    phones?: { phone: string; isPrimary?: boolean; outboundSmsBlocked?: boolean }[]
    emails?: { email: string; isPrimary?: boolean; isUnsubscribed?: boolean }[]
    priorityScore?: number | null
  } = {}) {
    n += 1
    const organizationId = opts.org ?? orgId
    const lead = await prisma.lead.create({
      data: {
        organizationId,
        displayName: `Test Owner ${n}`,
        name: `Test Owner ${n}`,
        source: TAG,
        statusLabel: opts.statusLabel ?? null,
        statusId: opts.statusId ?? null,
        primaryAddressFull: opts.address === undefined ? `${n} Example St, Brooklyn, NY 11201` : opts.address,
        primaryAddressSummary: opts.address === undefined ? `${n} Example St` : (opts.address?.split(',')[0] ?? null),
        priorityScore: opts.priorityScore ?? 70,
        topMatchFit: 80,
        captureStatus: 'EXTERNAL_BOTH',
        matchReason: 'made-up reason',
        dealflowDeepLink: 'https://example.invalid/signal',
        contacts: {
          create: {
            organizationId,
            displayName: `Test Owner ${n}`,
            phones: {
              create: (opts.phones ?? []).map((p, i) => ({
                phone: p.phone,
                type: 'mobile',
                isPrimary: p.isPrimary ?? i === 0,
                outboundSmsBlocked: p.outboundSmsBlocked ?? false,
              })),
            },
            emails: {
              create: (opts.emails ?? []).map((e, i) => ({
                email: e.email,
                type: 'work',
                isPrimary: e.isPrimary ?? i === 0,
                isUnsubscribed: e.isUnsubscribed ?? false,
              })),
            },
          },
        },
      },
      include: { contacts: { include: { phones: { orderBy: { phone: 'asc' } }, emails: { orderBy: { email: 'asc' } } } } },
    })
    return { lead, contact: lead.contacts[0] }
  }

  const entries = (leadId: string) =>
    prisma.activity.findMany({ where: { leadId }, orderBy: [{ activityAt: 'asc' }, { id: 'asc' }] })
  const phonesOf = (contactId: string) =>
    prisma.contactPhone.findMany({ where: { contactId }, orderBy: { phone: 'asc' } })
  const emailsOf = (contactId: string) =>
    prisma.contactEmail.findMany({ where: { contactId }, orderBy: { email: 'asc' } })

  beforeAll(async () => {
    orgId = (await prisma.organization.findFirstOrThrow({ where: { slug: 'dealflow-ryan' } })).id
    otherOrg = (await prisma.organization.create({ data: { slug: `${TAG}_other`.toLowerCase(), name: 'Brief 50 other org' } })).id
  })

  afterAll(async () => {
    const leads = await prisma.lead.findMany({ where: { source: TAG }, select: { id: true } })
    const ids = leads.map((l) => l.id)
    await prisma.activity.deleteMany({ where: { leadId: { in: ids } } })
    await prisma.lead.deleteMany({ where: { id: { in: ids } } })
    await prisma.dncSuppression.deleteMany({ where: { organizationId: orgId, reason: TAG } })
    await prisma.organization.deleteMany({ where: { id: otherOrg } })
  })

  it('changes the name (both name fields) and writes one plain-English timeline entry', async () => {
    const { lead } = await makeLead()
    const res = await put(lead.id, { displayName: '  Test Owner Renamed  ' })
    expect(res.status).toBe(200)
    expect(res.body.changes).toEqual(['Name changed'])
    const after = await prisma.lead.findUniqueOrThrow({ where: { id: lead.id } })
    expect(after.displayName).toBe('Test Owner Renamed')
    expect(after.name).toBe('Test Owner Renamed')
    const rows = await entries(lead.id)
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ type: 'Edit', bodyText: 'Name changed', organizationId: orgId, leadId: lead.id, userId: null, contactId: null })
  })

  it('changes the status, takes the existing spelling and status id, and says "Status: A → B"', async () => {
    const contacted = `B50 Contacted ${TAG}`
    await makeLead({ statusLabel: contacted, statusId: `stat_${TAG}_contacted` })
    const { lead } = await makeLead({ statusLabel: 'New', statusId: `stat_${TAG}_new` })

    const res = await put(lead.id, { statusLabel: contacted.toLowerCase() })
    expect(res.status).toBe(200)
    expect(res.body.changes).toEqual([`Status: New → ${contacted}`])
    let after = await prisma.lead.findUniqueOrThrow({ where: { id: lead.id } })
    expect(after.statusLabel).toBe(contacted)
    expect(after.statusId).toBe(`stat_${TAG}_contacted`)

    expect((await put(lead.id, { statusLabel: '' })).body.changes).toEqual([`Status cleared (was ${contacted})`])
    after = await prisma.lead.findUniqueOrThrow({ where: { id: lead.id } })
    expect(after.statusLabel).toBeNull()
    expect(after.statusId).toBeNull()

    const brandNew = `B50 Brand new ${TAG}`
    expect((await put(lead.id, { statusLabel: brandNew })).body.changes).toEqual([`Status set to ${brandNew}`])
    after = await prisma.lead.findUniqueOrThrow({ where: { id: lead.id } })
    expect(after.statusLabel).toBe(brandNew)
    expect(after.statusId).toBeNull()

    // The same status in other letter case is not a change.
    const same = await put(lead.id, { statusLabel: brandNew.toUpperCase() })
    expect(same.body.changes).toEqual([])
    expect(await entries(lead.id)).toHaveLength(3)
  })

  it('changes, removes and adds the address; the short address follows', async () => {
    const { lead } = await makeLead()
    expect((await put(lead.id, { primaryAddressFull: '100 Example St, Brooklyn, NY 11201' })).body.changes).toEqual(['Address changed'])
    let after = await prisma.lead.findUniqueOrThrow({ where: { id: lead.id } })
    expect(after.primaryAddressFull).toBe('100 Example St, Brooklyn, NY 11201')
    expect(after.primaryAddressSummary).toBe('100 Example St')

    expect((await put(lead.id, { primaryAddressFull: '   ' })).body.changes).toEqual(['Address removed'])
    after = await prisma.lead.findUniqueOrThrow({ where: { id: lead.id } })
    expect(after.primaryAddressFull).toBeNull()
    expect(after.primaryAddressSummary).toBeNull()

    expect((await put(lead.id, { primaryAddressFull: '200 Sample Ave' })).body.changes).toEqual(['Address added'])
    after = await prisma.lead.findUniqueOrThrow({ where: { id: lead.id } })
    expect(after.primaryAddressSummary).toBe('200 Sample Ave')
  })

  it('adds a phone in the standard form (+1 and 10 digits); the entry shows only its last 4 digits', async () => {
    const { lead, contact } = await makeLead({ phones: [{ phone: '+12125550101' }] })
    const res = await put(lead.id, {
      contacts: [{ id: contact.id, phones: [{ id: contact.phones[0].id }, { phone: '(212) 555-0123' }] }],
    })
    expect(res.status).toBe(200)
    expect(res.body.changes).toEqual(['Phone added (…0123)'])
    const phones = await phonesOf(contact.id)
    expect(phones.map((p) => p.phone)).toEqual(['+12125550101', '+12125550123'])
    expect(phones[0].id).toBe(contact.phones[0].id) // the untouched number is the same row
    expect(phones[1]).toMatchObject({ type: 'mobile', isPrimary: false })
    const [row] = await entries(lead.id)
    expect(row.bodyText).toBe('Phone added (…0123)')
    expect(row.bodyText).not.toMatch(/555|2125/)
  })

  it('changes and removes phones in one save: one entry, and the next number becomes primary', async () => {
    const { lead, contact } = await makeLead({
      phones: [{ phone: '+12125550101', isPrimary: true }, { phone: '+12125550102', isPrimary: false }],
    })
    const [first, second] = contact.phones
    const res = await put(lead.id, { contacts: [{ id: contact.id, phones: [{ id: second.id, phone: '212.555.0145' }, { id: first.id, remove: true }] }] })
    expect(res.status).toBe(200)
    expect(res.body.changes).toEqual(['Phone changed (…0102 → …0145)', 'Phone removed (…0101)'])
    const phones = await phonesOf(contact.id)
    expect(phones).toHaveLength(1)
    expect(phones[0]).toMatchObject({ phone: '+12125550145', isPrimary: true })
    expect(first.id).not.toBe(phones[0].id)
    const rows = await entries(lead.id)
    expect(rows).toHaveLength(1)
    expect(rows[0].bodyText).toBe('Phone changed (…0102 → …0145)\nPhone removed (…0101)')
  })

  it('the same number typed another way is not a change, and a save that changes nothing writes nothing', async () => {
    const { lead, contact } = await makeLead({ phones: [{ phone: '+12125550101' }], emails: [{ email: 'test.owner@example.com' }] })
    const res = await put(lead.id, {
      displayName: lead.displayName,
      statusLabel: null,
      primaryAddressFull: lead.primaryAddressFull,
      contacts: [{
        id: contact.id,
        phones: [{ id: contact.phones[0].id, phone: '1 (212) 555-0101' }],
        emails: [{ id: contact.emails[0].id, email: ' Test.Owner@Example.com ' }],
      }],
    })
    expect(res.status).toBe(200)
    expect(res.body.changes).toEqual([])
    expect(await entries(lead.id)).toHaveLength(0)
    expect((await phonesOf(contact.id)).map((p) => [p.id, p.phone])).toEqual([[contact.phones[0].id, '+12125550101']])
    expect((await emailsOf(contact.id)).map((e) => e.email)).toEqual(['test.owner@example.com'])
  })

  it('a "+" typed before a US number\'s 10 digits saves that US number (Brief 50 PR 13)', async () => {
    const { lead, contact } = await makeLead({ phones: [{ phone: '+12125550101' }] })
    const r = await put(lead.id, { contacts: [{ id: contact.id, phones: [{ id: contact.phones[0].id }, { phone: '+917 555 0123' }] }] })
    expect(r.status).toBe(200)
    expect((await phonesOf(contact.id)).map((p) => p.phone).sort()).toEqual(['+12125550101', '+19175550123'])
  })

  it('refuses a number that reads as outside the US, or isn\'t a number, with a plain message, and saves nothing', async () => {
    const { lead, contact } = await makeLead({ phones: [{ phone: '+12125550101' }] })
    // A genuinely foreign number (UK, Ofcom's fictional drama range): this form
    // refuses anything that isn't +1 and 10 digits. (Before Brief 50 PR 13 this
    // test used "+917…", which the shared parser then read as Indian.)
    const foreign = await put(lead.id, {
      displayName: 'Test Owner Should Not Save',
      contacts: [{ id: contact.id, phones: [{ id: contact.phones[0].id }, { phone: '+44 20 7946 0750' }] }],
    })
    expect(foreign.status).toBe(400)
    expect(foreign.body.error).toMatch(/US/)
    expect(foreign.body.error).toMatch(/10 digits/)
    expect(foreign.body.field).toBe(`contacts.${contact.id}.phones.1`)

    const notANumber = await put(lead.id, { contacts: [{ id: contact.id, phones: [{ phone: '555-0123' }] }] })
    expect(notANumber.status).toBe(400)
    expect(notANumber.body.error).toMatch(/isn't a phone number/)
    expect(notANumber.body.field).toBe(`contacts.${contact.id}.phones.0`)

    expect((await prisma.lead.findUniqueOrThrow({ where: { id: lead.id } })).displayName).toBe(lead.displayName)
    expect((await phonesOf(contact.id)).map((p) => p.phone)).toEqual(['+12125550101'])
    expect(await entries(lead.id)).toHaveLength(0)
  })

  it('adds (lowercased), changes and removes emails; refuses one that isn\'t an email address', async () => {
    const { lead, contact } = await makeLead({ emails: [{ email: 'old.owner@example.com' }, { email: 'gone@example.org' }] })
    const [gone, old] = contact.emails // ordered by address: gone@…, old.owner@…
    const res = await put(lead.id, {
      contacts: [{ id: contact.id, emails: [{ id: old.id, email: 'new.owner@example.com' }, { email: ' Test.Owner@Example.COM ' }, { id: gone.id, remove: true }] }],
    })
    expect(res.status).toBe(200)
    expect(res.body.changes).toEqual([
      'Email changed (o…@example.com → n…@example.com)',
      'Email added (t…@example.com)',
      'Email removed (g…@example.org)',
    ])
    expect((await emailsOf(contact.id)).map((e) => e.email)).toEqual(['new.owner@example.com', 'test.owner@example.com'])
    expect(gone.email).toBe('gone@example.org')

    const bad = await put(lead.id, { contacts: [{ id: contact.id, emails: [{ email: 'not an email' }] }] })
    expect(bad.status).toBe(400)
    expect(bad.body.error).toMatch(/isn't an email address/)
    expect(bad.body.field).toBe(`contacts.${contact.id}.emails.0`)
  })

  // Brief 50 PR 17: PR 5 let this number be removed (its lock read only
  // "texts blocked", which nothing sets). It's on the list, so it stays.
  it('a number on the Do not contact list can\'t be removed, emptied or changed, and its entry stays', async () => {
    const { lead, contact } = await makeLead({ phones: [{ phone: '+12125550111' }, { phone: '+12125550112' }] })
    await prisma.dncSuppression.create({
      data: { organizationId: orgId, phone: '+12125550111', source: 'internal', addedBy: 'test', reason: TAG },
    })
    const keep = contact.phones.find((p) => p.phone === '+12125550112')!
    const listed = contact.phones.find((p) => p.phone === '+12125550111')!
    for (const item of [{ id: listed.id, remove: true }, { id: listed.id, phone: '' }, { id: listed.id, phone: '347-555-0119' }]) {
      const res = await put(lead.id, { contacts: [{ id: contact.id, phones: [{ id: keep.id }, item] }] })
      expect(res.status, JSON.stringify(item)).toBe(400)
      expect(res.body.error).toMatch(/ending 0111 is on the Do not contact list/)
      expect(res.body.error).not.toMatch(/555/)
    }
    expect((await phonesOf(contact.id)).map((p) => p.phone)).toEqual(['+12125550111', '+12125550112'])
    expect(await prisma.dncSuppression.count({ where: { organizationId: orgId, phone: '+12125550111' } })).toBe(1)
    expect(await entries(lead.id)).toHaveLength(0)

    // Untouched, it doesn't get in the way of other edits.
    const ok = await put(lead.id, { contacts: [{ id: contact.id, phones: [{ id: listed.id }, { id: keep.id, remove: true }] }] })
    expect(ok.status).toBe(200)
    expect(ok.body.changes).toEqual(['Phone removed (…0112)'])
  })

  it('an opt-out stored before PR 13 as "+" and the 10 digits locks the lead\'s +1 number too', async () => {
    const { lead, contact } = await makeLead({ phones: [{ phone: '+13475550111' }] })
    await prisma.dncSuppression.create({
      data: { organizationId: orgId, phone: '+3475550111', source: 'internal', addedBy: 'test', reason: TAG },
    })
    const res = await put(lead.id, { contacts: [{ id: contact.id, phones: [{ id: contact.phones[0].id, remove: true }] }] })
    expect(res.status).toBe(400)
    expect(res.body.error).toMatch(/Do not contact/)
    expect((await phonesOf(contact.id)).map((p) => p.phone)).toEqual(['+13475550111'])
  })

  it('a number added to a lead with a Do not contact number goes on the list too, with the same reason, in the same save', async () => {
    const { lead, contact } = await makeLead({ phones: [{ phone: '+13475550121' }, { phone: '+13475550122' }] })
    await prisma.dncSuppression.create({
      data: { organizationId: orgId, phone: '+13475550121', source: 'internal', addedBy: 'settings-do-not-contact', reason: TAG },
    })
    const listed = contact.phones.find((p) => p.phone === '+13475550121')!
    const other = contact.phones.find((p) => p.phone === '+13475550122')!
    // One added, and one changed into a new number: both are new to the lead.
    const res = await put(lead.id, {
      contacts: [{ id: contact.id, phones: [{ id: listed.id }, { id: other.id, phone: '347-555-0124' }, { phone: '(347) 555-0123' }] }],
    })
    expect(res.status).toBe(200)
    expect(res.body.changes).toEqual([
      'Phone changed (…0122 → …0124)',
      'Phone added (…0123)',
      'Put on Do not contact (…0124), like another number on this lead',
      'Put on Do not contact (…0123), like another number on this lead',
    ])
    const rows = await prisma.dncSuppression.findMany({
      where: { organizationId: orgId, phone: { in: ['+13475550123', '+13475550124'] } },
      orderBy: { phone: 'asc' },
    })
    expect(rows.map((r) => [r.phone, r.source, r.reason, r.addedBy])).toEqual([
      ['+13475550123', 'internal', TAG, 'same-lead-opt-out:lead-edit'],
      ['+13475550124', 'internal', TAG, 'same-lead-opt-out:lead-edit'],
    ])
    // The number it replaced was never on the list and isn't put on it now.
    expect(await prisma.dncSuppression.count({ where: { organizationId: orgId, phone: '+13475550122' } })).toBe(0)
    // One timeline entry; only last 4 digits.
    const history = await entries(lead.id)
    expect(history).toHaveLength(1)
    expect(history[0].bodyText).toContain('Put on Do not contact (…0123)')
    expect(history[0].bodyText).not.toMatch(/347|555/)
    // And the new numbers are locked in turn.
    const after = await phonesOf(contact.id)
    const added = after.find((p) => p.phone === '+13475550123')!
    const locked = await put(lead.id, { contacts: [{ id: contact.id, phones: [{ id: added.id, remove: true }] }] })
    expect(locked.status).toBe(400)
  })

  it('if putting the number on the list fails, the number isn\'t added either (one transaction)', async () => {
    const { lead, contact } = await makeLead({ phones: [{ phone: '+13475550131' }] })
    await prisma.dncSuppression.create({
      data: { organizationId: orgId, phone: '+13475550131', source: 'internal', addedBy: 'test', reason: TAG },
    })
    // The same database, except that writing an opt-out fails inside the save's transaction.
    const failing = new Proxy(prisma, {
      get(target, prop, receiver) {
        if (prop !== '$transaction') return Reflect.get(target, prop, receiver)
        return (fn: (tx: unknown) => Promise<unknown>, opts?: unknown) =>
          target.$transaction(
            (tx) =>
              fn(
                new Proxy(tx, {
                  get(t, p, r) {
                    if (p !== 'dncSuppression') return Reflect.get(t, p, r)
                    const real = Reflect.get(t, p, r) as Record<string, unknown>
                    return new Proxy(real, {
                      get(d, q, rr) {
                        if (q === 'createMany' || q === 'create' || q === 'upsert') return async () => { throw new Error('opt-out write failed (test)') }
                        return Reflect.get(d, q, rr)
                      },
                    })
                  },
                }),
              ),
            opts as never,
          )
      },
    }) as typeof prisma
    await expect(
      applyLeadEdit(failing, orgId, lead.id, { contacts: [{ id: contact.id, phones: [{ id: contact.phones[0].id }, { phone: '347-555-0132' }] }] }),
    ).rejects.toThrow(/opt-out write failed/)
    expect((await phonesOf(contact.id)).map((p) => p.phone)).toEqual(['+13475550131'])
    expect(await prisma.dncSuppression.count({ where: { organizationId: orgId, phone: '+13475550132' } })).toBe(0)
    expect(await entries(lead.id)).toHaveLength(0)
  })

  it('a lead with no Do not contact number is unaffected: the added number isn\'t put on the list', async () => {
    const { lead, contact } = await makeLead({ phones: [{ phone: '+13475550141' }] })
    const res = await put(lead.id, { contacts: [{ id: contact.id, phones: [{ id: contact.phones[0].id }, { phone: '347-555-0142' }] }] })
    expect(res.status).toBe(200)
    expect(res.body.changes).toEqual(['Phone added (…0142)'])
    expect(await prisma.dncSuppression.count({ where: { organizationId: orgId, phone: { in: ['+13475550141', '+13475550142'] } } })).toBe(0)
    // And its numbers can still be changed and removed.
    const added = (await phonesOf(contact.id)).find((p) => p.phone === '+13475550142')!
    const removed = await put(lead.id, { contacts: [{ id: contact.id, phones: [{ id: contact.phones[0].id }, { id: added.id, remove: true }] }] })
    expect(removed.status).toBe(200)
  })

  it('a number marked "texts blocked" and an opted-out email stay: they can\'t be removed or changed here', async () => {
    const { lead, contact } = await makeLead({
      phones: [{ phone: '+12125550121', outboundSmsBlocked: true }, { phone: '+12125550122' }],
      emails: [{ email: 'optout@example.com', isUnsubscribed: true }],
    })
    const blocked = contact.phones.find((p) => p.outboundSmsBlocked)!
    const other = contact.phones.find((p) => !p.outboundSmsBlocked)!
    const removeBlocked = await put(lead.id, { contacts: [{ id: contact.id, phones: [{ id: other.id }, { id: blocked.id, remove: true }] }] })
    expect(removeBlocked.status).toBe(400)
    expect(removeBlocked.body.error).toMatch(/opted out|blocked/i)
    const changeBlocked = await put(lead.id, { contacts: [{ id: contact.id, phones: [{ id: blocked.id, phone: '212-555-0129' }, { id: other.id }] }] })
    expect(changeBlocked.status).toBe(400)
    const removeOptedOut = await put(lead.id, { contacts: [{ id: contact.id, emails: [{ id: contact.emails[0].id, remove: true }] }] })
    expect(removeOptedOut.status).toBe(400)
    expect(removeOptedOut.body.error).toMatch(/opted out/i)
    expect((await phonesOf(contact.id)).map((p) => [p.phone, p.outboundSmsBlocked])).toEqual([['+12125550121', true], ['+12125550122', false]])
    expect((await emailsOf(contact.id)).map((e) => [e.email, e.isUnsubscribed])).toEqual([['optout@example.com', true]])

    // Untouched, they don't get in the way of other edits.
    const ok = await put(lead.id, { contacts: [{ id: contact.id, phones: [{ id: blocked.id }, { id: other.id, remove: true }], emails: [{ id: contact.emails[0].id }] }] })
    expect(ok.status).toBe(200)
    expect(ok.body.changes).toEqual(['Phone removed (…0122)'])
  })

  it('one save with several changes writes one entry listing them all', async () => {
    const { lead, contact } = await makeLead({ statusLabel: 'New', phones: [{ phone: '+12125550131' }] })
    const res = await put(lead.id, {
      displayName: 'Test Owner Combined',
      statusLabel: 'Warm',
      primaryAddressFull: '300 Example Rd, Queens, NY',
      contacts: [{ id: contact.id, phones: [{ id: contact.phones[0].id }, { phone: '2125550132' }], emails: [{ email: 'combined@example.com' }] }],
    })
    expect(res.status).toBe(200)
    const rows = await entries(lead.id)
    expect(rows).toHaveLength(1)
    expect(rows[0].bodyText!.split('\n')).toEqual([
      'Name changed',
      'Status: New → Warm',
      'Address changed',
      'Phone added (…0132)',
      'Email added (c…@example.com)',
    ])
  })

  it('only edits leads, contacts and numbers of this organization and this lead', async () => {
    const theirs = await makeLead({ org: otherOrg, phones: [{ phone: '+12125550141' }] })
    const notMine = await put(theirs.lead.id, { displayName: 'Hijacked' })
    expect(notMine.status).toBe(404)
    expect((await prisma.lead.findUniqueOrThrow({ where: { id: theirs.lead.id } })).displayName).toBe(theirs.lead.displayName)

    const mine = await makeLead({ phones: [{ phone: '+12125550142' }] })
    const sibling = await makeLead({ phones: [{ phone: '+12125550143' }] })
    // Another lead's contact.
    const wrongContact = await put(mine.lead.id, { contacts: [{ id: sibling.contact.id, phones: [] }] })
    expect(wrongContact.status).toBe(400)
    // Another organization's contact.
    const foreignContact = await put(mine.lead.id, { contacts: [{ id: theirs.contact.id, phones: [] }] })
    expect(foreignContact.status).toBe(400)
    // Another contact's phone, smuggled in by id.
    const wrongPhone = await put(mine.lead.id, {
      contacts: [{ id: mine.contact.id, phones: [{ id: mine.contact.phones[0].id }, { id: sibling.contact.phones[0].id, phone: '212-555-0144' }] }],
    })
    expect(wrongPhone.status).toBe(400)

    expect((await phonesOf(sibling.contact.id)).map((p) => p.phone)).toEqual(['+12125550143'])
    expect((await phonesOf(theirs.contact.id)).map((p) => p.phone)).toEqual(['+12125550141'])
    expect((await phonesOf(mine.contact.id)).map((p) => p.phone)).toEqual(['+12125550142'])
    for (const l of [theirs.lead, mine.lead, sibling.lead]) expect(await entries(l.id)).toHaveLength(0)
  })

  it('DealFlow\'s values can\'t be changed here, and only the five fields are accepted', async () => {
    const { lead } = await makeLead({ priorityScore: 61 })
    for (const body of [
      { priorityScore: 99 },
      { topMatchFit: 1 },
      { captureStatus: 'NONE' },
      { matchReason: 'x' },
      { dealflowDeepLink: 'https://example.invalid/x' },
      { dealflowSignalSyncedAt: new Date().toISOString() },
      { mojoId: 'MOJO-TEST-1' },
      { displayName: 'Test Owner Sneaky', priorityScore: 99 },
    ]) {
      const res = await put(lead.id, body)
      expect(res.status, JSON.stringify(body)).toBe(400)
      expect(res.body.error).toMatch(/DealFlow/)
    }
    const other = await put(lead.id, { description: 'free text', timezone: 'America/Chicago' })
    expect(other.status).toBe(400)
    expect(other.body.error).toMatch(/name, status, address, phones and emails/)

    const after = await prisma.lead.findUniqueOrThrow({ where: { id: lead.id } })
    expect(after).toMatchObject({
      displayName: lead.displayName, priorityScore: 61, topMatchFit: 80, captureStatus: 'EXTERNAL_BOTH',
      matchReason: 'made-up reason', dealflowDeepLink: 'https://example.invalid/signal', mojoId: null, timezone: null,
    })
    expect(await entries(lead.id)).toHaveLength(0)
  })

  it('refuses a blank name with a plain message', async () => {
    const { lead } = await makeLead()
    const res = await put(lead.id, { displayName: '   ' })
    expect(res.status).toBe(400)
    expect(res.body.error).toBe("The name can't be blank.")
    expect(res.body.field).toBe('displayName')
  })

  it('a form opened before another number was added never removes that number', async () => {
    const { lead, contact } = await makeLead({ phones: [{ phone: '+12125550161' }] })
    // Added after the form was opened (another tab, or an upload that adds phones).
    const later = await prisma.contactPhone.create({ data: { contactId: contact.id, phone: '+12125550162', type: 'mobile' } })
    const res = await put(lead.id, { contacts: [{ id: contact.id, phones: [{ id: contact.phones[0].id }, { phone: '212-555-0163' }] }] })
    expect(res.status).toBe(200)
    expect(res.body.changes).toEqual(['Phone added (…0163)'])
    expect((await phonesOf(contact.id)).map((p) => p.id)).toContain(later.id)
  })

  it('a number removed elsewhere while the save runs: 409, nothing saved', async () => {
    const { lead, contact } = await makeLead({
      phones: [{ phone: '+12125550171', isPrimary: true }, { phone: '+12125550172', isPrimary: false }],
    })
    const [first, second] = contact.phones
    let release!: () => void
    const held = new Promise<void>((r) => (release = r))
    // Another transaction removes the second number and holds its row for a moment.
    const other = prisma.$transaction(async (tx) => {
      await tx.contactPhone.delete({ where: { id: second.id } })
      await held
    }, { timeout: 20_000 })
    await new Promise((r) => setTimeout(r, 300))
    // The save removes the first (the primary), so the second would take over.
    const saving = put(lead.id, { contacts: [{ id: contact.id, phones: [{ id: second.id }, { id: first.id, remove: true }] }] })
    await new Promise((r) => setTimeout(r, 800))
    release()
    await other
    const res = await saving
    expect(res.status).toBe(409)
    expect(res.body.error).toMatch(/changed somewhere else/)
    expect((await phonesOf(contact.id)).map((p) => p.id)).toEqual([first.id])
    expect(await entries(lead.id)).toHaveLength(0)
  })

  it('removing a number that was removed elsewhere meanwhile: 409, nothing saved', async () => {
    const { lead, contact } = await makeLead({ phones: [{ phone: '+12125550181' }, { phone: '+12125550182' }] })
    const [first, second] = contact.phones
    let release!: () => void
    const held = new Promise<void>((r) => (release = r))
    const other = prisma.$transaction(async (tx) => {
      await tx.contactPhone.delete({ where: { id: second.id } })
      await held
    }, { timeout: 20_000 })
    await new Promise((r) => setTimeout(r, 300))
    const saving = put(lead.id, {
      displayName: 'Test Owner Should Not Save',
      contacts: [{ id: contact.id, phones: [{ id: first.id }, { id: second.id, remove: true }] }],
    })
    await new Promise((r) => setTimeout(r, 800))
    release()
    await other
    const res = await saving
    expect(res.status).toBe(409)
    expect((await prisma.lead.findUniqueOrThrow({ where: { id: lead.id } })).displayName).toBe(lead.displayName)
    expect(await entries(lead.id)).toHaveLength(0)
  })
})
