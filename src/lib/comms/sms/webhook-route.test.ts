import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// Brief 41 (H12): the Twilio SMS webhook answers 500 when the inbound message or
// its STOP can't be recorded. It used to answer 200 regardless, so Twilio was
// told all was well and an opt-out could be lost.
const inbound = vi.hoisted(() => ({ handleInboundSms: vi.fn(), updateDeliveryState: vi.fn() }))
vi.mock('@/lib/comms/sms/inbound', () => inbound)
vi.mock('@/lib/shell/orgContext', () => ({ getCurrentOrgId: async () => 'org_1' }))

import { POST } from '@/app/api/comms/webhook/sms/route'
import { computeTwilioSignature } from '@/lib/comms/sms/twilio-client'

const req = (params: Record<string, string>) =>
  new Request('https://crm.example/api/comms/webhook/sms', {
    method: 'POST',
    body: new URLSearchParams(params).toString(),
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
  })

const ENV_KEYS = ['TWILIO_MOCK_SKIP_SIGNATURE', 'TWILIO_AUTH_TOKEN', 'VERCEL_ENV'] as const
const savedEnv = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]))
beforeEach(() => {
  vi.clearAllMocks()
  process.env.TWILIO_MOCK_SKIP_SIGNATURE = 'true'
})
afterEach(() => {
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k]
    else process.env[k] = savedEnv[k]
  }
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

// Brief 41.1 (F3): with no TWILIO_AUTH_TOKEN the route used to verify against
// '' — a key anyone has — so a forged STOP for any number was accepted and
// wrote a permanent opt-out. It now answers 503 until the token is set, and
// TWILIO_MOCK_SKIP_SIGNATURE (local mocks) is ignored in production.
describe('POST /api/comms/webhook/sms — signature', () => {
  const URL = 'https://crm.example/api/comms/webhook/sms'
  const STOP = { From: '+19175550147', To: '+15550000000', Body: 'STOP', MessageSid: 'SMforged' }
  const signed = (params: Record<string, string>, key: string) => {
    const r = req(params)
    r.headers.set('x-twilio-signature', computeTwilioSignature(key, URL, params))
    return r
  }
  beforeEach(() => {
    delete process.env.TWILIO_MOCK_SKIP_SIGNATURE
    delete process.env.TWILIO_AUTH_TOKEN
    delete process.env.VERCEL_ENV
    inbound.handleInboundSms.mockResolvedValue({ action: 'stop', messageId: 'm1' })
  })

  it('no token configured: a STOP signed with the empty key is refused (503), nothing recorded', async () => {
    const res = await POST(signed(STOP, ''))
    expect(res.status).toBe(503)
    expect(inbound.handleInboundSms).not.toHaveBeenCalled()
  })

  it('an empty or blank token counts as not configured', async () => {
    process.env.TWILIO_AUTH_TOKEN = ''
    expect((await POST(signed(STOP, ''))).status).toBe(503)
    process.env.TWILIO_AUTH_TOKEN = '  '
    expect((await POST(signed(STOP, '  '))).status).toBe(503)
    expect(inbound.handleInboundSms).not.toHaveBeenCalled()
  })

  it('with the token set: a correctly signed message → 200; a wrong signature → 401', async () => {
    process.env.TWILIO_AUTH_TOKEN = 'real-token'
    expect((await POST(signed(STOP, 'real-token'))).status).toBe(200)
    expect(inbound.handleInboundSms).toHaveBeenCalledOnce()
    expect((await POST(signed(STOP, ''))).status).toBe(401)
    expect(inbound.handleInboundSms).toHaveBeenCalledOnce()
  })

  it('in production TWILIO_MOCK_SKIP_SIGNATURE is ignored', async () => {
    process.env.VERCEL_ENV = 'production'
    process.env.TWILIO_MOCK_SKIP_SIGNATURE = 'true'
    expect((await POST(req(STOP))).status).toBe(503)
    process.env.TWILIO_AUTH_TOKEN = 'real-token'
    expect((await POST(req(STOP))).status).toBe(401)
    expect(inbound.handleInboundSms).not.toHaveBeenCalled()
  })
})
