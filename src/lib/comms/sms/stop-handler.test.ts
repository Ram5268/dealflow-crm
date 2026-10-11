import { describe, it, expect, vi, beforeEach } from 'vitest'

const dnc = vi.hoisted(() => ({ addInternalDnc: vi.fn() }))
vi.mock('@/lib/compliance/dnc/internal', () => dnc)

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

  it('a failed write throws (the opt-out is never dropped silently)', async () => {
    dnc.addInternalDnc.mockRejectedValue(new Error('db down'))
    await expect(handleStop('org_1', '+15551112222')).rejects.toThrow('db down')
  })
})
