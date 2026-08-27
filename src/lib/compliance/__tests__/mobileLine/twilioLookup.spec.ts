import { describe, it, expect } from 'vitest'
import { twilioLineLookup } from '@/lib/compliance/mobileLine/twilioLookup'
import { VendorError } from '@/lib/compliance/errors'

const fakeRes = (status: number, body: unknown) =>
  ({ ok: status >= 200 && status < 300, status, json: async () => body }) as unknown as Response

describe('twilioLineLookup', () => {
  it('parses line_type_intelligence', async () => {
    const r = await twilioLineLookup('+12125550001', {
      accountSid: 'AC', authToken: 't',
      fetchImpl: async () => fakeRes(200, { line_type_intelligence: { type: 'mobile', carrier_name: 'Verizon' } }),
    })
    expect(r).toEqual({ lineType: 'mobile', carrier: 'Verizon' })
  })

  it('defaults to unknown when the field is absent', async () => {
    const r = await twilioLineLookup('+1', { accountSid: 'AC', authToken: 't', fetchImpl: async () => fakeRes(200, {}) })
    expect(r.lineType).toBe('unknown')
  })

  it('non-2xx → vendor_error_mobile_line', async () => {
    await expect(
      twilioLineLookup('+1', { accountSid: 'AC', authToken: 't', fetchImpl: async () => fakeRes(404, {}) })
    ).rejects.toMatchObject({ reason: 'vendor_error_mobile_line' })
  })

  it('network throw → vendor_error_mobile_line', async () => {
    await expect(
      twilioLineLookup('+1', { accountSid: 'AC', authToken: 't', fetchImpl: async () => { throw new Error('x') } })
    ).rejects.toBeInstanceOf(VendorError)
  })
})
