import 'dotenv/config'
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { prisma } from '@/lib/prisma'
import { dispatch } from '@/lib/core-data/events/demux'
import { HANDLERS } from '@/lib/core-data/events/handlers'
import { resolvePayload } from '@/lib/core-data/events/listen'
import { mainIsTestDb } from '../setup/live-guard'

const enabled = mainIsTestDb() // Brief 41: refuses a live DATABASE_URL_MAIN
const CALL_ID = 'TEST_EVT_call_1'
const MSG_ID = 'TEST_EVT_msg_1'

let orgId: string
let leadId: string

describe.runIf(enabled)('event handlers', () => {
  beforeAll(async () => {
    orgId = (await prisma.organization.findFirstOrThrow({ where: { slug: 'dealflow-ryan' } })).id
    const lead = await prisma.lead.create({ data: { organizationId: orgId, displayName: 'TEST_EVT Lead' } })
    leadId = lead.id
  })

  afterAll(async () => {
    await prisma.activity.deleteMany({ where: { OR: [{ callId: CALL_ID }, { messageId: MSG_ID }] } })
    await prisma.message.deleteMany({ where: { id: MSG_ID } })
    await prisma.lead.deleteMany({ where: { id: leadId } })
  })

  it('call.connected appends an in-progress Call activity; idempotent', async () => {
    const payload = {
      type: 'call.connected',
      callId: CALL_ID,
      dialSessionId: 'ds1',
      leadId,
      contactId: null,
      remotePhone: '+12125551234',
      connectedAt: '2026-08-27T12:00:00.000Z',
      correlationId: 'cid-evt',
    }
    expect(await dispatch('crm_call', payload, HANDLERS)).toBe('handled')
    expect(await dispatch('crm_call', payload, HANDLERS)).toBe('handled') // dup emission
    const acts = await prisma.activity.findMany({ where: { callId: CALL_ID } })
    expect(acts).toHaveLength(1)
    expect(acts[0].type).toBe('Call')
    expect(acts[0].bodyText).toBe('Call in progress')
  })

  it('call.completed updates the activity and stores cost as a STRING (no coercion)', async () => {
    const payload = {
      type: 'call.completed',
      callId: CALL_ID,
      disposition: 'answered',
      duration: 63,
      cost: '12.3400',
      correlationId: 'cid-evt',
    }
    expect(await dispatch('crm_call', payload, HANDLERS)).toBe('handled')
    const act = await prisma.activity.findFirstOrThrow({ where: { callId: CALL_ID } })
    // The exact decimal string is preserved; it did NOT become numeric 12.34.
    expect(act.bodyText).toContain('"cost":"12.3400"')
    expect(act.bodyText).not.toContain('"cost":12.34')
  })

  it('message.received appends an Email activity referencing D\'s Message; idempotent', async () => {
    // Simulate Agent D having written the Message row before emitting.
    await prisma.message.create({
      data: {
        id: MSG_ID,
        organizationId: orgId,
        leadId,
        channel: 'email',
        direction: 'inbound',
        status: 'received',
        fromAddress: 'seller@example.com',
        subject: 'Re: your listing',
        bodyText: 'Still available?',
        activityAt: new Date('2026-08-27T13:00:00.000Z'),
      },
    })
    const payload = { messageId: MSG_ID, channel: 'email', leadId, correlationId: 'cid-evt' }
    expect(await dispatch('crm_message', payload, HANDLERS)).toBe('handled')
    expect(await dispatch('crm_message', payload, HANDLERS)).toBe('handled') // dup
    const acts = await prisma.activity.findMany({ where: { messageId: MSG_ID } })
    expect(acts).toHaveLength(1)
    expect(acts[0].type).toBe('Email')
    expect(acts[0].bodyText).toBe('Still available?')
  })

  it('scrub.completed writes nothing (observability only)', async () => {
    const before = await prisma.activity.count()
    expect(await dispatch('crm_scrub', { phoneCount: 5, blockedCount: 2, correlationId: 'cid-evt' }, HANDLERS)).toBe('handled')
    const after = await prisma.activity.count()
    expect(after).toBe(before)
  })

  it('resolvePayload follows an overflow pointer to NotifyOverflow', async () => {
    const row = await prisma.notifyOverflow.create({
      data: { channel: 'crm_lead_sync', payload: { count: 42, big: 'x'.repeat(10) } },
    })
    const resolved = await resolvePayload(JSON.stringify({ overflow: true, overflowId: row.id, correlationId: 'c' }))
    expect(resolved.count).toBe(42)
    const plain = await resolvePayload(JSON.stringify({ count: 7 }))
    expect(plain.count).toBe(7)
    await prisma.notifyOverflow.delete({ where: { id: row.id } })
  })
})
