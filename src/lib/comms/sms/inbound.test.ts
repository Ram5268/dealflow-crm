import { describe, it, expect, vi, beforeEach } from 'vitest'

const db = vi.hoisted(() => ({
  contactPhone: { findFirst: vi.fn() },
  message: { create: vi.fn() },
}))
const events = vi.hoisted(() => ({ notifyMessageReceived: vi.fn() }))
const stop = vi.hoisted(() => ({ handleStop: vi.fn() }))
vi.mock('../../prisma', () => ({ prisma: db }))
vi.mock('../events', () => events)
vi.mock('./stop-handler', () => stop)

import { handleInboundSms } from './inbound'

beforeEach(() => {
  vi.clearAllMocks()
  db.message.create.mockResolvedValue({ id: 'm1' })
  events.notifyMessageReceived.mockResolvedValue(undefined)
  stop.handleStop.mockResolvedValue({})
})

describe('handleInboundSms', () => {
  it('STOP → fires DNC handler, records the inbound message, emits message.received', async () => {
    db.contactPhone.findFirst.mockResolvedValue({ contactId: 'c1', contact: { leadId: 'l1' } })
    const r = await handleInboundSms({
      orgId: 'o',
      from: '+15551112222',
      to: '+15550000000',
      body: '  STOP ',
      messageSid: 'SM1',
    })
    expect(stop.handleStop).toHaveBeenCalledWith('+15551112222', undefined)
    expect(r.action).toBe('stop')
    expect(events.notifyMessageReceived).toHaveBeenCalledWith(
      expect.objectContaining({ channel: 'sms', messageId: 'm1', contactId: 'c1', leadId: 'l1' }),
    )
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

  it('recognizes UNSUBSCRIBE / CANCEL as opt-out', async () => {
    db.contactPhone.findFirst.mockResolvedValue(null)
    expect((await handleInboundSms({ orgId: 'o', from: '+1', to: '+2', body: 'unsubscribe', messageSid: 'a' })).action).toBe('stop')
    expect((await handleInboundSms({ orgId: 'o', from: '+1', to: '+2', body: 'CANCEL', messageSid: 'b' })).action).toBe('stop')
  })
})
