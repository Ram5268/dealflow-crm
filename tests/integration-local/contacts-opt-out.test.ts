import 'dotenv/config'
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { NextRequest } from 'next/server'
import { prisma } from '@/lib/prisma'
import { POST as createContact } from '@/app/api/contacts/route'
import { DELETE as deleteContact } from '@/app/api/contacts/[id]/route'
import { DELETE as deleteLead } from '@/app/api/leads/[id]/route'
import { POST as createLead } from '@/app/api/leads/route'
import { mainIsTestDb } from '../setup/live-guard'

// Brief 50 PR 17 (the planner's review, Brief 50 Revision 2, 2026-10-23): the
// contacts API and the lead's delete respect the Do not contact list like the
// Edit form does. A new contact on a lead that has a number on the list puts
// its numbers on the list too (same reason, same transaction); a contact or a
// lead holding a number on the list (or with texts blocked) can't be deleted.
// The list exists because a homeowner asked not to be contacted; nothing may
// contact a lead [Ryan]. Made-up people only; phones in 555-01xx.
const enabled = mainIsTestDb() // Brief 41: refuses a live DATABASE_URL_MAIN
const TAG = `B50PR17_${Date.now().toString(36)}`

function req(url: string, init?: { method?: string; body?: unknown }): NextRequest {
  return new NextRequest(new URL(url, 'http://localhost'), {
    method: init?.method ?? 'GET',
    ...(init?.body !== undefined ? { body: JSON.stringify(init.body), headers: { 'content-type': 'application/json' } } : {}),
  })
}

describe.runIf(enabled)('the contacts API and deletes respect the Do not contact list', () => {
  let orgId: string
  let n = 0

  async function makeLead(phones: { phone: string; outboundSmsBlocked?: boolean }[]) {
    n += 1
    const lead = await prisma.lead.create({
      data: {
        organizationId: orgId,
        displayName: `Test Owner ${n}`,
        source: TAG,
        contacts: {
          create: {
            organizationId: orgId,
            displayName: `Test Owner ${n}`,
            phones: {
              create: phones.map((p, i) => ({ phone: p.phone, type: 'mobile', isPrimary: i === 0, outboundSmsBlocked: p.outboundSmsBlocked ?? false })),
            },
          },
        },
      },
      include: { contacts: true },
    })
    return { lead, contact: lead.contacts[0] }
  }
  const optOut = (phone: string) =>
    prisma.dncSuppression.create({ data: { organizationId: orgId, phone, source: 'internal', addedBy: 'settings-do-not-contact', reason: TAG } })
  const entries = (leadId: string) => prisma.activity.findMany({ where: { leadId } })

  beforeAll(async () => {
    orgId = (await prisma.organization.findFirstOrThrow({ where: { slug: 'dealflow-ryan' } })).id
  })

  afterAll(async () => {
    const ids = (await prisma.lead.findMany({ where: { source: TAG }, select: { id: true } })).map((l) => l.id)
    await prisma.activity.deleteMany({ where: { leadId: { in: ids } } })
    await prisma.lead.deleteMany({ where: { id: { in: ids } } })
    await prisma.dncSuppression.deleteMany({ where: { organizationId: orgId, reason: TAG } })
  })

  it('a new contact on a lead with a Do not contact number: its numbers go on the list too, with the same reason', async () => {
    const { lead } = await makeLead([{ phone: '+13475550161' }])
    await optOut('+13475550161')
    const res = await createContact(
      req('/api/contacts', { method: 'POST', body: { leadId: lead.id, displayName: 'Test Co-Owner', phones: [{ phone: '347-555-0162' }, { phone: '+1 347 555 0161' }] } }),
    )
    expect(res.status).toBe(201)
    const rows = await prisma.dncSuppression.findMany({ where: { organizationId: orgId, phone: { in: ['+13475550161', '+13475550162'] } }, orderBy: { phone: 'asc' } })
    expect(rows.map((r) => [r.phone, r.reason, r.addedBy])).toEqual([
      ['+13475550161', TAG, 'settings-do-not-contact'],
      ['+13475550162', TAG, 'same-lead-opt-out:contacts-api'],
    ])
    const history = await entries(lead.id)
    expect(history).toHaveLength(1)
    expect(history[0].type).toBe('Edit')
    expect(history[0].bodyText).toBe("A new contact's phone put on Do not contact (…0162), like another number on this lead")
  })

  // Review round 1: the other way round.
  it('a new contact bringing a number on the list puts the lead\'s other numbers on it too', async () => {
    const { lead } = await makeLead([{ phone: '+13475550155' }])
    await optOut('+13475550156')
    const res = await createContact(
      req('/api/contacts', { method: 'POST', body: { leadId: lead.id, displayName: 'Test Co-Owner', phones: [{ phone: '347-555-0156' }] } }),
    )
    expect(res.status).toBe(201)
    expect(await prisma.dncSuppression.findFirst({ where: { organizationId: orgId, phone: '+13475550155' } })).toMatchObject({
      reason: TAG,
      addedBy: 'same-lead-opt-out:contacts-api',
    })
    const history = await entries(lead.id)
    expect(history.map((h) => h.bodyText)).toEqual(['Put on Do not contact (…0155), like a number just added to this lead'])
  })

  it('a new contact on a lead with no Do not contact number is unaffected', async () => {
    const { lead } = await makeLead([{ phone: '+13475550163' }])
    const res = await createContact(req('/api/contacts', { method: 'POST', body: { leadId: lead.id, displayName: 'Test Co-Owner', phones: [{ phone: '347-555-0164' }] } }))
    expect(res.status).toBe(201)
    expect(await prisma.dncSuppression.count({ where: { organizationId: orgId, phone: { in: ['+13475550163', '+13475550164'] } } })).toBe(0)
    expect(await entries(lead.id)).toHaveLength(0)
  })

  // Executor's follow-up: POST /api/leads takes no contacts or phones (its
  // schema drops anything else), so a new lead made there has no number that
  // could route around an opt-out. Numbers come in through POST /api/contacts.
  it('POST /api/leads never creates a phone, even when one is sent', async () => {
    await optOut('+13475550192')
    const res = await createLead(
      req('/api/leads', {
        method: 'POST',
        body: {
          displayName: 'Test Owner New', source: TAG,
          contacts: { create: { organizationId: orgId, displayName: 'x', phones: { create: [{ phone: '+13475550192', type: 'mobile' }, { phone: '+13475550193', type: 'mobile' }] } } },
        },
      }),
    )
    expect(res.status).toBe(201)
    const { lead } = await res.json()
    expect(await prisma.contact.count({ where: { leadId: lead.id } })).toBe(0)
    expect(await prisma.contactPhone.count({ where: { phone: { in: ['+13475550192', '+13475550193'] } } })).toBe(0)
  })

  it('a contact holding a number on the list, or with texts blocked, can\'t be deleted; one with neither can', async () => {
    const listed = await makeLead([{ phone: '+13475550165' }])
    await optOut('+13475550165')
    const refused = await deleteContact(req(`/api/contacts/${listed.contact.id}`, { method: 'DELETE' }), { params: Promise.resolve({ id: listed.contact.id }) })
    expect(refused.status).toBe(400)
    expect((await refused.json()).error).toMatch(/ending 0165 is on the Do not contact list/)
    expect(await prisma.contact.count({ where: { id: listed.contact.id } })).toBe(1)

    const blocked = await makeLead([{ phone: '+13475550166', outboundSmsBlocked: true }])
    const refused2 = await deleteContact(req(`/api/contacts/${blocked.contact.id}`, { method: 'DELETE' }), { params: Promise.resolve({ id: blocked.contact.id }) })
    expect(refused2.status).toBe(400)
    expect(await prisma.contact.count({ where: { id: blocked.contact.id } })).toBe(1)

    const plain = await makeLead([{ phone: '+13475550167' }])
    const ok = await deleteContact(req(`/api/contacts/${plain.contact.id}`, { method: 'DELETE' }), { params: Promise.resolve({ id: plain.contact.id }) })
    expect(ok.status).toBe(200)
    expect(await prisma.contact.count({ where: { id: plain.contact.id } })).toBe(0)
  })

  it('a lead holding a number on the list can\'t be deleted (an old "+" and 10 digits entry counts); one without can', async () => {
    const listed = await makeLead([{ phone: '+13475550168' }])
    await optOut('+3475550168') // stored before PR 13
    const refused = await deleteLead(req(`/api/leads/${listed.lead.id}`, { method: 'DELETE' }), { params: Promise.resolve({ id: listed.lead.id }) })
    expect(refused.status).toBe(400)
    expect((await refused.json()).error).toMatch(/Do not contact/)
    expect(await prisma.lead.count({ where: { id: listed.lead.id } })).toBe(1)

    const plain = await makeLead([{ phone: '+13475550169' }])
    const ok = await deleteLead(req(`/api/leads/${plain.lead.id}`, { method: 'DELETE' }), { params: Promise.resolve({ id: plain.lead.id }) })
    expect(ok.status).toBe(200)
    expect(await prisma.lead.count({ where: { id: plain.lead.id } })).toBe(0)
  })
})
