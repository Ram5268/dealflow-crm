import { describe, it, expect, vi, beforeEach } from 'vitest'

const compliance = vi.hoisted(() => ({ addInternalDnc: vi.fn() }))
vi.mock('../clients/compliance', () => compliance)

import { handleStop } from './stop-handler'

beforeEach(() => vi.clearAllMocks())

describe('handleStop', () => {
  it('adds internal DNC with the STOP reason + source label (Ryan-specified shape)', async () => {
    compliance.addInternalDnc.mockResolvedValue({
      id: 'd',
      phone: '+15551112222',
      source: 'internal',
      addedAt: 't',
      added: true,
    })
    await handleStop('+15551112222', 'corr-1')
    expect(compliance.addInternalDnc).toHaveBeenCalledWith({
      phone: '+15551112222',
      reason: 'sms_stop_received',
      addedBy: 'sms-inbound-handler',
      correlationId: 'corr-1',
    })
  })
})
