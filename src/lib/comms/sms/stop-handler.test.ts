import { describe, it, expect, vi, beforeEach } from 'vitest'

const dnc = vi.hoisted(() => ({ addInternalDnc: vi.fn() }))
const db = vi.hoisted(() => ({ prisma: { dncSuppression: { updateMany: vi.fn() } } }))
vi.mock('@/lib/compliance/dnc/internal', () => dnc)
vi.mock('@/lib/compliance/db', () => db)

import { handleStop } from './stop-handler'

beforeEach(() => vi.clearAllMocks())

describe('handleStop', () => {
  // Brief 41 (H12): in-process, not an HTTP self-call (which carried no Basic-auth
  // credentials and pointed at the wrong URL, so STOPs never reached the list).
  it('adds the phone to the org internal DNC in-process, with the STOP reason + source label', async () => {
    dnc.addInternalDnc.mockResolvedValue({ id: 'd', phone: '+15551112222', source: 'internal', addedAt: 't', added: true })
    const r = await handleStop('org_1', '+15551112222')
    expect(dnc.addInternalDnc).toHaveBeenCalledWith('org_1', {
      phone: '+15551112222',
      reason: 'sms_stop_received',
      addedBy: 'sms-inbound-handler',
    })
    expect(r.added).toBe(true)
  })

  // Brief 41.1 (F5): an opt-out phrase inside a longer message is recorded with
  // its own reason, so the opt-out list (and later the inbox) can tell it apart
  // from a plain STOP for review.
  it('records a phrase match with its own reason', async () => {
    dnc.addInternalDnc.mockResolvedValue({ id: 'd', phone: '+15551112222', source: 'internal', addedAt: 't', added: true })
    await handleStop('org_1', '+15551112222', { kind: 'phrase', phrase: 'stop' })
    expect(dnc.addInternalDnc).toHaveBeenCalledWith('org_1', {
      phone: '+15551112222',
      reason: 'sms_stop_phrase',
      addedBy: 'sms-inbound-handler',
    })
    await handleStop('org_1', '+15551112222', { kind: 'keyword', phrase: 'stop' })
    expect(dnc.addInternalDnc).toHaveBeenLastCalledWith('org_1', expect.objectContaining({ reason: 'sms_stop_received' }))
  })

  // A clear STOP after an earlier phrase match: the number no longer needs a
  // review, so the reason is upgraded (only rows still marked as a phrase).
  it('a keyword for a number already listed from a phrase upgrades its reason', async () => {
    dnc.addInternalDnc.mockResolvedValue({ id: 'd', phone: '+15551112222', source: 'internal', addedAt: 't', added: false })
    db.prisma.dncSuppression.updateMany.mockResolvedValue({ count: 1 })
    await handleStop('org_1', '(555) 111-2222', { kind: 'keyword', phrase: 'stop' })
    expect(db.prisma.dncSuppression.updateMany).toHaveBeenCalledWith({
      where: { organizationId: 'org_1', phone: '+15551112222', source: 'internal', reason: 'sms_stop_phrase' },
      data: { reason: 'sms_stop_received' },
    })
  })

  it('no reason change for a new row or for another phrase match', async () => {
    dnc.addInternalDnc.mockResolvedValue({ id: 'd', phone: '+15551112222', source: 'internal', addedAt: 't', added: true })
    await handleStop('org_1', '+15551112222', { kind: 'keyword', phrase: 'stop' })
    dnc.addInternalDnc.mockResolvedValue({ id: 'd', phone: '+15551112222', source: 'internal', addedAt: 't', added: false })
    await handleStop('org_1', '+15551112222', { kind: 'phrase', phrase: 'stop' })
    expect(db.prisma.dncSuppression.updateMany).not.toHaveBeenCalled()
  })

  it('a failed write throws (the opt-out is never dropped silently)', async () => {
    dnc.addInternalDnc.mockRejectedValue(new Error('db down'))
    await expect(handleStop('org_1', '+15551112222')).rejects.toThrow('db down')
  })
})
