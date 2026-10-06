import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// Brief 41 (H12): the Twilio SMS webhook answers 500 when the inbound message or
// its STOP can't be recorded. It used to answer 200 regardless, so Twilio was
// told all was well and an opt-out could be lost.
const inbound = vi.hoisted(() => ({ handleInboundSms: vi.fn(), updateDeliveryState: vi.fn() }))
vi.mock('@/lib/comms/sms/inbound', () => inbound)
vi.mock('@/lib/shell/orgContext', () => ({ getCurrentOrgId: async () => 'org_1' }))

import { POST } from '@/app/api/comms/webhook/sms/route'

const req = (params: Record<string, string>) =>
  new Request('https://crm.example/api/comms/webhook/sms', {
    method: 'POST',
    body: new URLSearchParams(params).toString(),
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
  })

beforeEach(() => {
  vi.clearAllMocks()
  process.env.TWILIO_MOCK_SKIP_SIGNATURE = 'true'
})
afterEach(() => {
  delete process.env.TWILIO_MOCK_SKIP_SIGNATURE
})

describe('POST /api/comms/webhook/sms', () => {
  it('a handled inbound message (STOP included) → 200 TwiML', async () => {
    inbound.handleInboundSms.mockResolvedValue({ action: 'stop', messageId: 'm1' })
    const res = await POST(req({ From: '+15551112222', To: '+15550000000', Body: 'STOP', MessageSid: 'SM1' }))
    expect(res.status).toBe(200)
    expect(await res.text()).toContain('<Response></Response>')
    expect(inbound.handleInboundSms).toHaveBeenCalledWith(expect.objectContaining({ orgId: 'org_1', from: '+15551112222', body: 'STOP', messageSid: 'SM1' }))
  })

  it('a STOP that could not be recorded → 500, never 200', async () => {
    inbound.handleInboundSms.mockRejectedValue(new Error('db down'))
    const res = await POST(req({ From: '+15551112222', To: '+15550000000', Body: 'STOP', MessageSid: 'SM2' }))
    expect(res.status).toBe(500)
  })

  it('a delivery-status callback → 200', async () => {
    inbound.updateDeliveryState.mockResolvedValue(undefined)
    const res = await POST(req({ MessageSid: 'SM3', MessageStatus: 'delivered' }))
    expect(res.status).toBe(200)
    expect(inbound.updateDeliveryState).toHaveBeenCalledWith('SM3', 'delivered')
    expect(inbound.handleInboundSms).not.toHaveBeenCalled()
  })
})
