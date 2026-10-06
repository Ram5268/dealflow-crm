import { describe, it, expect, vi, beforeEach } from 'vitest'

const db = vi.hoisted(() => ({
  contactPhone: { findFirst: vi.fn() },
  message: { create: vi.fn(), findUnique: vi.fn() },
}))
const events = vi.hoisted(() => ({ notifyMessageReceived: vi.fn() }))
const stop = vi.hoisted(() => ({ handleStop: vi.fn() }))
vi.mock('../../prisma', () => ({ prisma: db }))
vi.mock('../events', () => events)
vi.mock('./stop-handler', () => stop)

import { handleInboundSms } from './inbound'

beforeEach(() => {
  vi.clearAllMocks()
  db.message.findUnique.mockResolvedValue(null)
  db.message.create.mockResolvedValue({ id: 'm1' })
  events.notifyMessageReceived.mockResolvedValue(undefined)
  stop.handleStop.mockResolvedValue({})
})

describe('handleInboundSms', () => {
  it('STOP → records the inbound message FIRST, then adds the DNC in-process, emits message.received', async () => {
    db.contactPhone.findFirst.mockResolvedValue({ contactId: 'c1', contact: { leadId: 'l1' } })
    const r = await handleInboundSms({
      orgId: 'o',
      from: '+15551112222',
      to: '+15550000000',
      body: '  STOP ',
      messageSid: 'SM1',
    })
    expect(stop.handleStop).toHaveBeenCalledWith('o', '+15551112222')
    // Brief 41 (H12): the message is saved before the STOP write.
    expect(db.message.create.mock.invocationCallOrder[0]).toBeLessThan(stop.handleStop.mock.invocationCallOrder[0])
    expect(r).toEqual({ action: 'stop', messageId: 'm1' })
    expect(events.notifyMessageReceived).toHaveBeenCalledWith(
      expect.objectContaining({ channel: 'sms', messageId: 'm1', contactId: 'c1', leadId: 'l1' }),
    )
  })

  it('a STOP whose DNC write fails throws (so the webhook answers non-2xx); the message is already saved', async () => {
    db.contactPhone.findFirst.mockResolvedValue(null)
    stop.handleStop.mockRejectedValue(new Error('db down'))
    await expect(
      handleInboundSms({ orgId: 'o', from: '+15551112222', to: '+15550000000', body: 'STOP', messageSid: 'SM9' }),
    ).rejects.toThrow('db down')
    expect(db.message.create).toHaveBeenCalledOnce()
  })

  it("Twilio's redelivery of the same message reuses it (no duplicate, no second event) and retries the STOP", async () => {
    db.message.findUnique.mockResolvedValue({ id: 'm-existing' })
    const r = await handleInboundSms({ orgId: 'o', from: '+15551112222', to: '+15550000000', body: 'STOP', messageSid: 'SM9' })
    expect(db.message.findUnique).toHaveBeenCalledWith({ where: { providerMessageId: 'twilio:SM9' }, select: { id: true } })
    expect(db.message.create).not.toHaveBeenCalled()
    expect(events.notifyMessageReceived).not.toHaveBeenCalled()
    expect(stop.handleStop).toHaveBeenCalledWith('o', '+15551112222')
    expect(r).toEqual({ action: 'stop', messageId: 'm-existing' })
  })

  it('two deliveries racing: the loser finds the saved message instead of failing', async () => {
    db.contactPhone.findFirst.mockResolvedValue(null)
    db.message.findUnique.mockResolvedValueOnce(null).mockResolvedValueOnce({ id: 'm-winner' })
    db.message.create.mockRejectedValue(new Error('Unique constraint failed on providerMessageId'))
    const r = await handleInboundSms({ orgId: 'o', from: '+15551112222', to: '+15550000000', body: 'hi', messageSid: 'SM5' })
    expect(r).toEqual({ action: 'message', messageId: 'm-winner' })
    expect(events.notifyMessageReceived).not.toHaveBeenCalled()
  })

  it('a save error that is not a race still throws', async () => {
    db.contactPhone.findFirst.mockResolvedValue(null)
    db.message.create.mockRejectedValue(new Error('db down'))
    await expect(
      handleInboundSms({ orgId: 'o', from: '+15551112222', to: '+15550000000', body: 'hi', messageSid: 'SM6' }),
    ).rejects.toThrow('db down')
    expect(stop.handleStop).not.toHaveBeenCalled()
  })

  it('a failed message.received event is logged, not thrown (the message is saved)', async () => {
    db.contactPhone.findFirst.mockResolvedValue(null)
    events.notifyMessageReceived.mockRejectedValue(new Error('notify down'))
    const r = await handleInboundSms({ orgId: 'o', from: '+15551112222', to: '+15550000000', body: 'STOP', messageSid: 'SM7' })
    expect(r.action).toBe('stop')
    expect(stop.handleStop).toHaveBeenCalledOnce()
  })

  it('normal inbound → records + emits, no STOP path', async () => {
    db.contactPhone.findFirst.mockResolvedValue(null)
    const r = await handleInboundSms({
      orgId: 'o',
      from: '+15559998888',
      to: '+15550000000',
      body: 'is it still available?',
      messageSid: 'SM2',
    })
    expect(stop.handleStop).not.toHaveBeenCalled()
    expect(r.action).toBe('message')
    expect(events.notifyMessageReceived).toHaveBeenCalledOnce()
    // unresolved contact → null ids, still emits
    expect(events.notifyMessageReceived).toHaveBeenCalledWith(
      expect.objectContaining({ channel: 'sms', contactId: undefined, leadId: undefined }),
    )
  })

  it("matches the contact by the number's canonical E.164 form", async () => {
    db.contactPhone.findFirst.mockResolvedValue(null)
    await handleInboundSms({ orgId: 'o', from: '(917) 331-2047', to: '+15550000000', body: 'STOP', messageSid: 'SM8' })
    expect(db.contactPhone.findFirst).toHaveBeenCalledWith(expect.objectContaining({ where: { phone: '+19173312047', contact: { organizationId: 'o' } } }))
    expect(stop.handleStop).toHaveBeenCalledWith('o', '+19173312047')
  })

  it('recognizes UNSUBSCRIBE / CANCEL as opt-out', async () => {
    db.contactPhone.findFirst.mockResolvedValue(null)
    expect((await handleInboundSms({ orgId: 'o', from: '+1', to: '+2', body: 'unsubscribe', messageSid: 'a' })).action).toBe('stop')
    expect((await handleInboundSms({ orgId: 'o', from: '+1', to: '+2', body: 'CANCEL', messageSid: 'b' })).action).toBe('stop')
  })
})
