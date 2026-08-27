import { describe, it, expect, beforeEach } from 'vitest'
import { checkLitigatorBatch } from '@/lib/compliance/litigator/check'
import type { LitigatorVendorClient } from '@/lib/compliance/litigator/vendors/types'
import { noopLitigatorVendor } from '@/lib/compliance/litigator/vendors/noop'
import { makeMockLitigatorVendor } from '@/lib/compliance/litigator/vendors/mock'
import { VendorError } from '@/lib/compliance/errors'
import { recordVendorResult, resetCircuitsForTest } from '@/lib/compliance/bulk/circuitBreaker'
import { resetEnvCache } from '@/lib/compliance/env'

beforeEach(() => resetCircuitsForTest())

function db(known: Array<{ phone: string; vendor: string }> = [], recentClean: string[] = []) {
  const created: any[] = []
  return {
    created,
    client: {
      litigatorSuppression: {
        findMany: async () => known,
        createMany: async (a: any) => (created.push(...a.data), { count: a.data.length }),
      },
      scrubLog: {
        findMany: async () => recentClean.map((phone) => ({ phone })),
        createMany: async () => ({ count: 0 }),
      },
    },
  }
}

describe('checkLitigatorBatch', () => {
  it('empty input → empty map', async () => {
    expect((await checkLitigatorBatch('o', [])).size).toBe(0)
  })

  it('known litigator → blocked litigator with vendor detail', async () => {
    const d = db([{ phone: '+1', vendor: 'tcpa_shield' }])
    const r = await checkLitigatorBatch('o', ['+1'], { db: d.client, vendor: noopLitigatorVendor })
    expect(r.get('+1')).toEqual({ status: 'blocked', reason: 'litigator', detail: { vendor: 'tcpa_shield' } })
  })

  it('recent clean (<30d) → clean', async () => {
    const d = db([], ['+1'])
    const r = await checkLitigatorBatch('o', ['+1'], { db: d.client, vendor: noopLitigatorVendor })
    expect(r.get('+1')).toEqual({ status: 'clean' })
  })

  it('live scrub: hit upserts + blocks, clean passes', async () => {
    const d = db()
    const vendor = makeMockLitigatorVendor(new Set(['+lit']))
    const r = await checkLitigatorBatch('o', ['+lit', '+ok'], { db: d.client, vendor })
    expect(r.get('+lit')).toMatchObject({ status: 'blocked', reason: 'litigator' })
    expect(r.get('+ok')).toEqual({ status: 'clean' })
    expect(d.created).toHaveLength(1)
  })

  it('noop vendor → vendor_error_not_configured', async () => {
    const r = await checkLitigatorBatch('o', ['+1'], { db: db().client, vendor: noopLitigatorVendor })
    expect(r.get('+1')).toEqual({ status: 'error', reason: 'vendor_error_not_configured' })
  })

  it('vendor error → fail-closed vendor_error_litigator', async () => {
    const vendor: LitigatorVendorClient = {
      name: 'x', batchSize: 1, rateLimitPerSec: 1,
      async scrubBatch() { throw new VendorError('vendor_error_litigator', 'x') },
    }
    const r = await checkLitigatorBatch('o', ['+1'], { db: db().client, vendor })
    expect(r.get('+1')).toEqual({ status: 'error', reason: 'vendor_error_litigator' })
  })

  it('open circuit → circuit_open_litigator', async () => {
    const T = 6_000_000
    for (let i = 0; i < 5; i++) recordVendorResult('litigator', false, T + i)
    const vendor = makeMockLitigatorVendor(new Set())
    const r = await checkLitigatorBatch('o', ['+1'], { db: db().client, vendor, now: new Date(T + 10) })
    expect(r.get('+1')).toEqual({ status: 'error', reason: 'circuit_open_litigator' })
  })

  it('production defaults (no vendor) → noop fail-closed', async () => {
    delete process.env.LITIGATOR_VENDOR
    resetEnvCache()
    const r = await checkLitigatorBatch('o', ['+1'], { db: db().client })
    expect(r.get('+1')).toEqual({ status: 'error', reason: 'vendor_error_not_configured' })
  })

  it('useCircuit:false + clean vendor → clean', async () => {
    const r = await checkLitigatorBatch('o', ['+1'], { db: db().client, vendor: makeMockLitigatorVendor(new Set()), useCircuit: false })
    expect(r.get('+1')).toEqual({ status: 'clean' })
  })

  it('a non-VendorError throw falls back to vendor_error_litigator', async () => {
    const vendor = { name: 'x', batchSize: 1, rateLimitPerSec: 1, async scrubBatch(): Promise<never> { throw new Error('boom') } }
    const r = await checkLitigatorBatch('o', ['+1'], { db: db().client, vendor })
    expect(r.get('+1')).toEqual({ status: 'error', reason: 'vendor_error_litigator' })
  })

  it('dedupes duplicate known rows and duplicate clean rows', async () => {
    const knownDup = db([{ phone: '+1', vendor: 'a' }, { phone: '+1', vendor: 'b' }])
    const r1 = await checkLitigatorBatch('o', ['+1'], { db: knownDup.client, vendor: noopLitigatorVendor })
    expect(r1.get('+1')).toEqual({ status: 'blocked', reason: 'litigator', detail: { vendor: 'a' } }) // first wins

    const cleanDup = db([], ['+2', '+2'])
    const r2 = await checkLitigatorBatch('o', ['+2'], { db: cleanDup.client, vendor: noopLitigatorVendor })
    expect(r2.get('+2')).toEqual({ status: 'clean' })
  })

  it('vendor error with useCircuit:false does not touch the breaker', async () => {
    const vendor = { name: 'x', batchSize: 1, rateLimitPerSec: 1, async scrubBatch(): Promise<never> { throw new VendorError('vendor_error_litigator', 'x') } }
    const r = await checkLitigatorBatch('o', ['+1'], { db: db().client, vendor, useCircuit: false })
    expect(r.get('+1')).toEqual({ status: 'error', reason: 'vendor_error_litigator' })
  })

  it('dedupes duplicate vendor rows (hit then clean for the same phone)', async () => {
    const vendor: LitigatorVendorClient = {
      name: 'x', batchSize: 1, rateLimitPerSec: 1,
      async scrubBatch() {
        return { perPhone: [{ phone: '+1', isLitigator: true }, { phone: '+1', isLitigator: false }], checkedAt: 'x' }
      },
    }
    const r = await checkLitigatorBatch('o', ['+1'], { db: db().client, vendor })
    expect(r.get('+1')).toMatchObject({ status: 'blocked', reason: 'litigator' })
  })
})
