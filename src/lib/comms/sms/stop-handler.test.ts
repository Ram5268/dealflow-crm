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

  it('a failed write throws (the opt-out is never dropped silently)', async () => {
    dnc.addInternalDnc.mockRejectedValue(new Error('db down'))
    await expect(handleStop('org_1', '+15551112222')).rejects.toThrow('db down')
  })
})
