import { describe, it, expect } from 'vitest'
import { getLitigatorVendor } from '@/lib/compliance/litigator/vendors/index'
import { makeMockLitigatorVendor } from '@/lib/compliance/litigator/vendors/mock'
import { noopLitigatorVendor } from '@/lib/compliance/litigator/vendors/noop'
import { makeTcpaShieldLitigatorVendor, parseTcpaShieldLitigator } from '@/lib/compliance/litigator/vendors/tcpaShield'
import { VendorError } from '@/lib/compliance/errors'

const fakeRes = (status: number, body: unknown) =>
  ({ ok: status >= 200 && status < 300, status, json: async () => body }) as unknown as Response

describe('litigator vendor factory', () => {
  it('resolves selected vendors and falls back to noop', () => {
    expect(getLitigatorVendor('tcpa_shield').name).toBe('tcpa_shield')
    expect(getLitigatorVendor('mock').name).toBe('mock')
    expect(getLitigatorVendor('blacklist_alliance').name).toBe('blacklist_alliance')
    expect(getLitigatorVendor('litigator_scrub').name).toBe('litigator_scrub')
    expect(getLitigatorVendor(undefined).name).toBe('noop')
  })
})

describe('noop litigator vendor', () => {
  it('throws vendor_error_not_configured', async () => {
    await expect(noopLitigatorVendor.scrubBatch(['+1'], { correlationId: 'c' })).rejects.toMatchObject({
      reason: 'vendor_error_not_configured',
    })
  })
})

describe('mock + parse + TCPA Shield litigator client', () => {
  it('mock flags litigators', async () => {
    const v = makeMockLitigatorVendor(new Set(['+lit']))
    const r = await v.scrubBatch(['+lit', '+ok'], { correlationId: 'c' })
    expect(r.perPhone.find((p) => p.phone === '+lit')).toMatchObject({ isLitigator: true })
    expect(r.perPhone.find((p) => p.phone === '+ok')).toMatchObject({ isLitigator: false })
  })
  it('parse maps litigator flag', () => {
    expect(parseTcpaShieldLitigator({ results: [{ phone: '+1', litigator: true, matchId: 'm' }] })[0]).toEqual({
      phone: '+1', isLitigator: true, vendorMatchId: 'm',
    })
    expect(parseTcpaShieldLitigator({})).toEqual([])
  })
  it('non-2xx → vendor_error_litigator', async () => {
    const v = makeTcpaShieldLitigatorVendor({ apiKey: 'k', baseUrl: 'http://x', fetchImpl: async () => fakeRes(403, {}) })
    await expect(v.scrubBatch(['+1'], { correlationId: 'c' })).rejects.toBeInstanceOf(VendorError)
  })
  it('2xx parses', async () => {
    const v = makeTcpaShieldLitigatorVendor({ apiKey: 'k', baseUrl: 'http://x', fetchImpl: async () => fakeRes(200, { results: [{ phone: '+1', litigator: false }] }) })
    const r = await v.scrubBatch(['+1'], { correlationId: 'c' })
    expect(r.perPhone[0]).toMatchObject({ isLitigator: false })
  })
})
