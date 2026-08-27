import { describe, it, expect } from 'vitest'
import { getDncVendor } from '@/lib/compliance/dnc/vendors/index'
import { makeMockDncVendor } from '@/lib/compliance/dnc/vendors/mock'
import { noopDncVendor } from '@/lib/compliance/dnc/vendors/noop'
import { makeTcpaShieldDncVendor, parseTcpaShieldDnc } from '@/lib/compliance/dnc/vendors/tcpaShield'
import { VendorError } from '@/lib/compliance/errors'

const fakeRes = (status: number, body: unknown) =>
  ({ ok: status >= 200 && status < 300, status, json: async () => body }) as unknown as Response

describe('DNC vendor factory', () => {
  it('resolves selected vendors and falls back to noop', () => {
    expect(getDncVendor('tcpa_shield').name).toBe('tcpa_shield')
    expect(getDncVendor('TCPA Shield').name).toBe('tcpa_shield')
    expect(getDncVendor('mock').name).toBe('mock')
    expect(getDncVendor('possiblenow').name).toBe('possiblenow')
    expect(getDncVendor('dnc.com').name).toBe('dnc_com')
    expect(getDncVendor(undefined).name).toBe('noop')
    expect(getDncVendor('who-dis').name).toBe('noop')
  })
})

describe('noop DNC vendor', () => {
  it('throws vendor_error_not_configured (fail-closed sentinel, not a clean pass)', async () => {
    await expect(noopDncVendor.scrubBatch(['+1'], { correlationId: 'c' })).rejects.toMatchObject({
      reason: 'vendor_error_not_configured',
    })
  })
})

describe('mock DNC vendor', () => {
  it('flags blocked phones and passes the rest', async () => {
    const v = makeMockDncVendor(new Map([['+block', 'federal']]))
    const r = await v.scrubBatch(['+block', '+ok'], { correlationId: 'c' })
    expect(r.perPhone.find((p) => p.phone === '+block')).toMatchObject({ onList: true, list: 'federal' })
    expect(r.perPhone.find((p) => p.phone === '+ok')).toMatchObject({ onList: false })
  })
})

describe('parseTcpaShieldDnc (provisional)', () => {
  it('maps state + federal + clean', () => {
    const rows = parseTcpaShieldDnc({
      results: [
        { phone: '+1', dnc: true, listType: 'state', state: 'ny', matchId: 'm1' },
        { phone: '+2', dnc: true, listType: 'federal' },
        { phone: '+3', dnc: false },
      ],
    })
    expect(rows[0]).toEqual({ phone: '+1', onList: true, list: 'state:NY', vendorMatchId: 'm1' })
    expect(rows[1]).toMatchObject({ onList: true, list: 'federal' })
    expect(rows[2]).toMatchObject({ onList: false, list: '' })
  })
  it('tolerates a missing results array', () => {
    expect(parseTcpaShieldDnc({})).toEqual([])
  })
})

describe('TCPA Shield DNC client (fake fetch)', () => {
  it('parses a 2xx response', async () => {
    const v = makeTcpaShieldDncVendor({ apiKey: 'k', baseUrl: 'http://x', fetchImpl: async () => fakeRes(200, { results: [{ phone: '+1', dnc: false }] }) })
    const r = await v.scrubBatch(['+1'], { correlationId: 'c' })
    expect(r.perPhone[0]).toMatchObject({ phone: '+1', onList: false })
  })
  it('non-2xx → vendor_error_dnc', async () => {
    const v = makeTcpaShieldDncVendor({ apiKey: 'k', baseUrl: 'http://x', fetchImpl: async () => fakeRes(500, {}) })
    await expect(v.scrubBatch(['+1'], { correlationId: 'c' })).rejects.toBeInstanceOf(VendorError)
  })
  it('network throw → vendor_error_dnc', async () => {
    const v = makeTcpaShieldDncVendor({ apiKey: 'k', baseUrl: 'http://x', fetchImpl: async () => { throw new Error('econnrefused') } })
    await expect(v.scrubBatch(['+1'], { correlationId: 'c' })).rejects.toMatchObject({ reason: 'vendor_error_dnc' })
  })
  it('malformed json → vendor_error_dnc', async () => {
    const v = makeTcpaShieldDncVendor({ apiKey: 'k', baseUrl: 'http://x', fetchImpl: async () => ({ ok: true, status: 200, json: async () => { throw new Error('bad') } }) as unknown as Response })
    await expect(v.scrubBatch(['+1'], { correlationId: 'c' })).rejects.toBeInstanceOf(VendorError)
  })
})
