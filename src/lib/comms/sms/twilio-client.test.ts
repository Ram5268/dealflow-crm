import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { computeTwilioSignature, verifyTwilioSignature, sendSms } from './twilio-client'

const token = 'auth-token'
const url = 'https://crm.example.com/api/comms/webhook/sms'
const params = { From: '+15551112222', To: '+15553334444', Body: 'STOP' }

describe('twilio signature', () => {
  it('computes deterministically and verifies', () => {
    const sig = computeTwilioSignature(token, url, params)
    expect(verifyTwilioSignature(token, url, params, sig)).toBe(true)
  })

  it('rejects a wrong or missing signature', () => {
    expect(verifyTwilioSignature(token, url, params, 'nope')).toBe(false)
    expect(verifyTwilioSignature(token, url, params, null)).toBe(false)
  })

  it('rejects when params are tampered', () => {
    const sig = computeTwilioSignature(token, url, params)
    expect(verifyTwilioSignature(token, url, { ...params, Body: 'GO' }, sig)).toBe(false)
  })
})

describe('sendSms', () => {
  const fetchMock = vi.fn()
  beforeEach(() => {
    vi.stubGlobal('fetch', fetchMock)
    fetchMock.mockReset()
  })
  afterEach(() => vi.unstubAllGlobals())

  const cfg = {
    accountSid: 'AC1',
    authToken: 'tok',
    messagingServiceSid: 'MG1',
    brandId: 'B',
    campaignId: 'C',
    apiBase: 'http://localhost:4002',
  }

  it('POSTs a form to the Messages endpoint and returns sid/status', async () => {
    fetchMock.mockResolvedValue({ ok: true, status: 201, json: async () => ({ sid: 'SM1', status: 'queued' }) })
    const r = await sendSms({ to: '+15553334444', body: 'hi' }, cfg)
    expect(r).toEqual({ sid: 'SM1', status: 'queued' })

    const [calledUrl, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(calledUrl).toBe('http://localhost:4002/2010-04-01/Accounts/AC1/Messages.json')
    expect(String(init.body)).toContain('MessagingServiceSid=MG1')
    expect(String(init.body)).toContain('To=%2B15553334444')
  })

  it('throws on non-2xx', async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 500, json: async () => ({}) })
    await expect(sendSms({ to: '+1', body: 'x' }, cfg)).rejects.toThrow(/HTTP 500/)
  })
})
