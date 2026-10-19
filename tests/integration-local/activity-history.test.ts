import 'dotenv/config'
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { prisma } from '@/lib/prisma'
import { dispatch } from '@/lib/core-data/events/demux'
import { HANDLERS } from '@/lib/core-data/events/handlers'
import { handleStatusWebhook } from '@/lib/telephony/twilio/statusWebhook'
import { recoverLostEmissions } from '@/lib/telephony/reconciliation/job'
import { handleInboundSms } from '@/lib/comms/sms/inbound'
import { saveMessages, emitMessageReceived } from '@/lib/comms/email/gmail-adapter'
import type { PersistableMessage } from '@/lib/comms/email/gmail-sync'
import { mainIsTestDb } from '../setup/live-guard'

// Brief 50 (PR 3): the lead timeline ("Activity") is written where the call or
// message itself is written, so it works in production, where nothing runs the
// LISTEN/NOTIFY consumer (src/lib/core-data/events/listen.ts). Every test below
// goes through the real write path and never starts that consumer. Made-up
// people, streets and 555-01xx phone numbers only.

const enabled = mainIsTestDb() // refuses a live DATABASE_URL_MAIN (Brief 41)
const TAG = 'b50pr3'
const SID = `CA_${TAG}_` // Call.providerCallSid prefix
const SMS = `SM_${TAG}_` // Twilio MessageSid prefix
const MAIL = `gmail:<${TAG}-` // Message.providerMessageId prefix (email)
const GHOST = `call_${TAG}_ghost` // a callId with no Call row

let orgA: string // the seeded org (dealflow-ryan)
let orgB: string // a throwaway second org
let leadA: string
let contactA: string
let leadB: string
let contactB: string

let orgFail: string // a throwaway org whose timeline writes fail (TEST_TRIGGER)
let orgSlow: string // a throwaway org whose timeline inserts are slow (TEST_TRIGGER)

const OWNER_PHONE = '+12125550142' // fictional; on an org-A contact AND an org-B contact
const OUR_NUMBER = '+12125550100'
const FAIL_PHONE = '+12125550143' // fictional; texts STOP to orgFail
const FAIL_SLUG = `${TAG}-org-fail`
const SLOW_SLUG = `${TAG}-org-slow`

// A test-database trigger on Activity inserts:
// - for FAIL_SLUG's org it fails, so the tests can prove a failed timeline
//   write never takes the call's status, its event, or an opt-out down with it;
// - for SLOW_SLUG's org it waits 0.3 s before inserting, so concurrent writers
//   really overlap and only the per-call lock keeps them to one entry.
const TEST_TRIGGER = [
  `CREATE OR REPLACE FUNCTION ${TAG}_test_activity() RETURNS trigger LANGUAGE plpgsql AS $$
   BEGIN
     IF NEW."organizationId" IN (SELECT id FROM "Organization" WHERE slug = '${FAIL_SLUG}') THEN
       RAISE EXCEPTION '${TAG}: simulated timeline write failure';
     ELSIF NEW."organizationId" IN (SELECT id FROM "Organization" WHERE slug = '${SLOW_SLUG}') THEN
       PERFORM pg_sleep(0.3);
     END IF;
     RETURN NEW;
   END $$`,
  `DROP TRIGGER IF EXISTS ${TAG}_test_activity ON "Activity"`,
  `CREATE TRIGGER ${TAG}_test_activity BEFORE INSERT ON "Activity" FOR EACH ROW EXECUTE FUNCTION ${TAG}_test_activity()`,
]
const DROP_TEST_TRIGGER = [
  `DROP TRIGGER IF EXISTS ${TAG}_test_activity ON "Activity"`,
  `DROP FUNCTION IF EXISTS ${TAG}_test_activity()`,
]

async function dropOrg(slug: string) {
  const org = await prisma.organization.findUnique({ where: { slug } })
  if (!org) return
  await prisma.activity.deleteMany({ where: { organizationId: org.id } })
  await prisma.dncSuppression.deleteMany({ where: { organizationId: org.id } })
  await prisma.message.deleteMany({ where: { organizationId: org.id } })
  await prisma.call.deleteMany({ where: { organizationId: org.id } })
  await prisma.lead.deleteMany({ where: { organizationId: org.id } }) // contacts + phones cascade
  await prisma.organization.delete({ where: { id: org.id } })
}

async function makeCall(sid: string, data: { organizationId: string; leadId?: string | null; contactId?: string | null; status?: string; ageMin?: number }) {
  return prisma.call.create({
    data: {
      organizationId: data.organizationId,
      leadId: data.leadId ?? null,
      contactId: data.contactId ?? null,
      direction: 'outbound',
      callMethod: 'power',
      localPhone: OUR_NUMBER,
      remotePhone: OWNER_PHONE,
      providerCallSid: sid,
      source: 'dealflow-crm',
      status: data.status ?? 'in-progress',
      ...(data.ageMin ? { dateCreated: new Date(Date.now() - data.ageMin * 60_000) } : {}),
    },
  })
}

const callEntries = (callId: string) => prisma.activity.findMany({ where: { callId } })
const messageEntries = (messageId: string) => prisma.activity.findMany({ where: { messageId } })
// Exactly what the lead page reads (src/app/leads/[id]/page.tsx).
const leadTimeline = (organizationId: string, leadId: string) =>
  prisma.activity.findMany({ where: { organizationId, leadId }, orderBy: [{ activityAt: 'desc' }] })

async function cleanup() {
  const calls = await prisma.call.findMany({ where: { providerCallSid: { startsWith: SID } }, select: { id: true } })
  const msgs = await prisma.message.findMany({
    where: { OR: [{ providerMessageId: { startsWith: `twilio:${SMS}` } }, { providerMessageId: { startsWith: MAIL } }] },
    select: { id: true },
  })
  await prisma.activity.deleteMany({
    where: { OR: [{ callId: { in: [GHOST, ...calls.map((c) => c.id)] } }, { messageId: { in: msgs.map((m) => m.id) } }] },
  })
  await prisma.message.deleteMany({ where: { id: { in: msgs.map((m) => m.id) } } })
  await prisma.call.deleteMany({ where: { id: { in: calls.map((c) => c.id) } } })
}

describe.runIf(enabled)('activity history is written where calls and messages are written', () => {
  beforeAll(async () => {
    orgA = (await prisma.organization.findFirstOrThrow({ where: { slug: 'dealflow-ryan' } })).id
    await cleanup()
    const stale = await prisma.organization.findUnique({ where: { slug: `${TAG}-org-b` } })
    if (stale) {
      // Left by an interrupted run.
      await prisma.activity.deleteMany({ where: { organizationId: stale.id } })
      await prisma.message.deleteMany({ where: { organizationId: stale.id } })
      await prisma.lead.deleteMany({ where: { organizationId: stale.id } }) // contacts + phones cascade
      await prisma.organization.delete({ where: { id: stale.id } })
    }
    orgB = (await prisma.organization.create({ data: { slug: `${TAG}-org-b`, name: 'Brief 50 PR 3 second org' } })).id
    await dropOrg(FAIL_SLUG) // left by an interrupted run
    await dropOrg(SLOW_SLUG)
    orgFail = (await prisma.organization.create({ data: { slug: FAIL_SLUG, name: 'Brief 50 PR 3 failing-timeline org' } })).id
    orgSlow = (await prisma.organization.create({ data: { slug: SLOW_SLUG, name: 'Brief 50 PR 3 slow-timeline org' } })).id
    for (const sql of TEST_TRIGGER) await prisma.$executeRawUnsafe(sql)

    leadA = (await prisma.lead.create({ data: { organizationId: orgA, displayName: `${TAG} Test Owner 1` } })).id
    contactA = (
      await prisma.contact.create({
        data: {
          organizationId: orgA, leadId: leadA, displayName: 'Test Owner 1',
          phones: { create: { phone: OWNER_PHONE, type: 'mobile' } },
        },
      })
    ).id
    leadB = (await prisma.lead.create({ data: { organizationId: orgB, displayName: `${TAG} Test Owner 2` } })).id
    contactB = (
      await prisma.contact.create({
        data: {
          organizationId: orgB, leadId: leadB, displayName: 'Test Owner 2',
          phones: { create: { phone: OWNER_PHONE, type: 'mobile' } },
        },
      })
    ).id
  })

  afterAll(async () => {
    for (const sql of DROP_TEST_TRIGGER) await prisma.$executeRawUnsafe(sql)
    await dropOrg(FAIL_SLUG)
    await dropOrg(SLOW_SLUG)
    await cleanup()
    await prisma.activity.deleteMany({ where: { OR: [{ organizationId: orgB }, { leadId: { in: [leadA, leadB] } }] } })
    await prisma.lead.deleteMany({ where: { id: { in: [leadA, leadB] } } }) // contacts + phones cascade
    await prisma.organization.deleteMany({ where: { id: orgB } })
  })

  describe('calls', () => {
    it('a completed call (Twilio status callback) writes exactly one Call entry on the lead, with its contact', async () => {
      const call = await makeCall(`${SID}1`, { organizationId: orgA, leadId: leadA, contactId: contactA })
      const r = await handleStatusWebhook(prisma, {
        CallSid: `${SID}1`, CallStatus: 'completed', CallDuration: '42', Price: '-0.0130',
      })
      expect(r.emitted).toBe(true)

      const rows = await callEntries(call.id)
      expect(rows).toHaveLength(1)
      expect(rows[0]).toMatchObject({ organizationId: orgA, leadId: leadA, contactId: contactA, type: 'Call' })
      expect(rows[0].bodyText).toContain('"disposition":"answered"')
      expect(rows[0].bodyText).toContain('"duration":42')
      expect(rows[0].bodyText).toContain('"cost":"0.013"') // the decimal string, never a number
      // ...and it is what the lead page shows.
      expect((await leadTimeline(orgA, leadA)).map((a) => a.callId)).toContain(call.id)
    })

    it('replays never duplicate it: the same callback again, and the event consumer hearing connected + completed', async () => {
      const call = await prisma.call.findUniqueOrThrow({ where: { providerCallSid: `${SID}1` } })
      const params = { CallSid: `${SID}1`, CallStatus: 'completed', CallDuration: '42', Price: '-0.0130' }
      expect((await handleStatusWebhook(prisma, params)).emitted).toBe(false)
      expect((await handleStatusWebhook(prisma, params)).emitted).toBe(false)
      // A local boot script's consumer (scripts/boot-*.ts) hearing the events late.
      await dispatch('crm_call', {
        type: 'call.connected', callId: call.id, dialSessionId: '', leadId: leadA, contactId: contactA,
        remotePhone: OWNER_PHONE, connectedAt: new Date().toISOString(), correlationId: `${TAG}-c1`,
      }, HANDLERS)
      await dispatch('crm_call', {
        type: 'call.completed', callId: call.id, disposition: 'answered', duration: 42, cost: '0.013',
        correlationId: `${TAG}-c2`,
      }, HANDLERS)

      const rows = await callEntries(call.id)
      expect(rows).toHaveLength(1)
      expect(rows[0].bodyText).toContain('"disposition":"answered"') // not reset to "Call in progress"
    })

    it('several writers at once still leave one entry', async () => {
      // In the slow org each insert waits 0.3 s, so all four writers look for
      // the entry before any has committed one; only the lock stops duplicates.
      const call = await makeCall(`${SID}2`, { organizationId: orgSlow })
      const completed = {
        type: 'call.completed', callId: call.id, disposition: 'no-answer', duration: 0, cost: null, correlationId: `${TAG}-c3`,
      }
      await Promise.all([
        handleStatusWebhook(prisma, { CallSid: `${SID}2`, CallStatus: 'no-answer', CallDuration: '0' }),
        dispatch('crm_call', completed, HANDLERS),
        dispatch('crm_call', completed, HANDLERS),
        dispatch('crm_call', completed, HANDLERS),
      ])
      const rows = await callEntries(call.id)
      expect(rows).toHaveLength(1)
      expect(rows[0]).toMatchObject({ organizationId: orgSlow, type: 'Call' })
    })

    it('a call whose status callback never came gets its entry from the reconciliation recovery', async () => {
      const call = await makeCall(`${SID}3`, { organizationId: orgA, leadId: leadA, contactId: contactA, status: 'busy', ageMin: 10 })
      await prisma.call.update({ where: { id: call.id }, data: { disposition: 'busy' } })
      await recoverLostEmissions(prisma)
      const rows = await callEntries(call.id)
      expect(rows).toHaveLength(1)
      expect(rows[0]).toMatchObject({ organizationId: orgA, leadId: leadA, contactId: contactA, type: 'Call' })
      expect(rows[0].bodyText).toContain('"disposition":"busy"')
    })

    it("org scoping: an entry takes its call's organization and never links another organization's lead", async () => {
      // A call in org B that (wrongly) points at org A's lead and contact.
      const call = await makeCall(`${SID}4`, { organizationId: orgB, leadId: leadA, contactId: contactA })
      await handleStatusWebhook(prisma, { CallSid: `${SID}4`, CallStatus: 'completed', CallDuration: '5' })
      const rows = await callEntries(call.id)
      expect(rows).toHaveLength(1)
      expect(rows[0]).toMatchObject({ organizationId: orgB, leadId: null, contactId: null })
      expect((await leadTimeline(orgA, leadA)).map((a) => a.callId)).not.toContain(call.id)
    })

    it("org scoping: the event consumer files a call it hasn't seen under the call's own organization and lead", async () => {
      // The consumer used to guess "the first organization" and drop the lead.
      const call = await makeCall(`${SID}5`, { organizationId: orgB, leadId: leadB, contactId: contactB, status: 'completed' })
      await dispatch('crm_call', {
        type: 'call.completed', callId: call.id, disposition: 'answered', duration: 9, cost: null, correlationId: `${TAG}-c5`,
      }, HANDLERS)
      const rows = await callEntries(call.id)
      expect(rows).toHaveLength(1)
      expect(rows[0]).toMatchObject({ organizationId: orgB, leadId: leadB, contactId: contactB, type: 'Call' })
    })

    it("a failing timeline write never rolls back the call's final status or its event", async () => {
      const call = await makeCall(`${SID}6`, { organizationId: orgFail })
      const r = await handleStatusWebhook(prisma, { CallSid: `${SID}6`, CallStatus: 'completed', CallDuration: '7' })
      expect(r.emitted).toBe(true)
      const after = await prisma.call.findUniqueOrThrow({ where: { id: call.id } })
      expect(after).toMatchObject({ status: 'completed', disposition: 'answered', duration: 7 })
      expect(after.emittedAt).not.toBeNull()
      expect(await callEntries(call.id)).toHaveLength(0)

      // The reconciliation recovery likewise still marks a stranded call emitted.
      const stranded = await makeCall(`${SID}7`, { organizationId: orgFail, status: 'busy', ageMin: 10 })
      await recoverLostEmissions(prisma)
      expect((await prisma.call.findUniqueOrThrow({ where: { id: stranded.id } })).emittedAt).not.toBeNull()
      expect(await callEntries(stranded.id)).toHaveLength(0)
    })

    it('the event consumer writes nothing for a call that does not exist (no made-up organization)', async () => {
      await dispatch('crm_call', {
        type: 'call.completed', callId: GHOST, disposition: 'answered', duration: 1, cost: null, correlationId: `${TAG}-c6`,
      }, HANDLERS)
      expect(await callEntries(GHOST)).toHaveLength(0)
    })
  })

  describe('messages', () => {
    it('an inbound text (Twilio SMS webhook path) writes exactly one SMS entry on the matched lead, with its contact', async () => {
      const r = await handleInboundSms({
        orgId: orgA, from: OWNER_PHONE, to: OUR_NUMBER, body: 'Is the house on Example St still for sale?', messageSid: `${SMS}1`,
      })
      expect(r.action).toBe('message')
      const rows = await messageEntries(r.messageId)
      expect(rows).toHaveLength(1)
      expect(rows[0]).toMatchObject({
        organizationId: orgA, leadId: leadA, contactId: contactA, type: 'SMS',
        bodyText: 'Is the house on Example St still for sale?',
      })
      expect((await leadTimeline(orgA, leadA)).map((a) => a.messageId)).toContain(r.messageId)
    })

    it("replays never duplicate it: Twilio's redelivery, and the event consumer hearing message.received", async () => {
      const r = await handleInboundSms({
        orgId: orgA, from: OWNER_PHONE, to: OUR_NUMBER, body: 'Is the house on Example St still for sale?', messageSid: `${SMS}1`,
      })
      await dispatch('crm_message', { messageId: r.messageId, channel: 'sms', leadId: leadA, contactId: contactA, correlationId: `${TAG}-m1` }, HANDLERS)
      await dispatch('crm_message', { messageId: r.messageId, channel: 'sms', correlationId: `${TAG}-m2` }, HANDLERS)
      expect(await messageEntries(r.messageId)).toHaveLength(1)
    })

    it('an inbound email (Gmail/Outlook sync path) writes exactly one Email entry', async () => {
      const row: PersistableMessage = {
        providerMessageId: `${MAIL}1@example.com>`,
        providerThreadId: `gmail:${TAG}-thread`,
        threadDbId: `${TAG}-thread`,
        channel: 'email',
        direction: 'incoming',
        status: 'inbox',
        fromAddress: 'test.owner@example.com',
        toAddresses: ['agent@example.com'],
        ccAddresses: [],
        bccAddresses: [],
        subject: 'Your note about 100 Example St',
        bodyText: 'Call me next week.',
        activityAt: new Date('2026-10-19T14:00:00Z'),
        contactId: contactA,
        leadId: leadA,
      }
      const { insertedIds } = await saveMessages(orgA, [row])
      expect(insertedIds).toEqual([row.providerMessageId])
      // The sync calls this once per newly saved inbound message (two at once
      // here, as two overlapping syncs of one mailbox would).
      await Promise.all([emitMessageReceived(row), emitMessageReceived(row)])
      const msg = await prisma.message.findUniqueOrThrow({ where: { providerMessageId: row.providerMessageId } })
      const rows = await messageEntries(msg.id)
      expect(rows).toHaveLength(1)
      expect(rows[0]).toMatchObject({
        organizationId: orgA, leadId: leadA, contactId: contactA, type: 'Email', bodyText: 'Call me next week.',
      })

      // The event consumer hearing it later adds nothing.
      await dispatch('crm_message', { messageId: msg.id, channel: 'email', leadId: leadA, correlationId: `${TAG}-m3` }, HANDLERS)
      expect(await messageEntries(msg.id)).toHaveLength(1)
    })

    it("a text's opt-out is recorded even when its timeline write fails", async () => {
      const r = await handleInboundSms({
        orgId: orgFail, from: FAIL_PHONE, to: OUR_NUMBER, body: 'STOP', messageSid: `${SMS}3`,
      })
      expect(r.action).toBe('stop')
      expect(await prisma.dncSuppression.findUnique({
        where: { organizationId_phone_source: { organizationId: orgFail, phone: FAIL_PHONE, source: 'internal' } },
      })).not.toBeNull()
      expect(await messageEntries(r.messageId)).toHaveLength(0) // the failed write left nothing behind
    })

    it("org scoping: a text to org B is filed under org B's lead even when org A has a contact with the same phone", async () => {
      const r = await handleInboundSms({
        orgId: orgB, from: OWNER_PHONE, to: OUR_NUMBER, body: 'Who is this?', messageSid: `${SMS}2`,
      })
      const rows = await messageEntries(r.messageId)
      expect(rows).toHaveLength(1)
      expect(rows[0]).toMatchObject({ organizationId: orgB, leadId: leadB, contactId: contactB, type: 'SMS' })
      expect((await leadTimeline(orgA, leadA)).map((a) => a.messageId)).not.toContain(r.messageId)
    })
  })
})
