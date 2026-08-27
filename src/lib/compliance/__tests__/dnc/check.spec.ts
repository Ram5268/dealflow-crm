import { describe, it, expect, beforeEach } from 'vitest'
import { checkDncBatch } from '@/lib/compliance/dnc/check'
import type { DncVendorClient } from '@/lib/compliance/dnc/vendors/types'
import { noopDncVendor } from '@/lib/compliance/dnc/vendors/noop'
import { makeMockDncVendor } from '@/lib/compliance/dnc/vendors/mock'
import { VendorError } from '@/lib/compliance/errors'
import { recordVendorResult, resetCircuitsForTest } from '@/lib/compliance/bulk/circuitBreaker'
import { resetEnvCache } from '@/lib/compliance/env'

beforeEach(() => resetCircuitsForTest())

function db(suppressions: Array<{ phone: string; source: string }> = [], recentClean: string[] = []) {
  const created: any[] = []
  const logged: any[] = []
  return {
    created,
    logged,
    client: {
      dncSuppression: {
        findMany: async () => suppressions,
        createMany: async (a: any) => (created.push(...a.data), { count: a.data.length }),
      },
      scrubLog: {
        findMany: async () => recentClean.map((phone) => ({ phone })),
        createMany: async (a: any) => (logged.push(...a.data), { count: a.data.length }),
      },
    },
  }
}

const noSleep = async () => {}

describe('checkDncBatch', () => {
  it('empty input → empty map', async () => {
    expect((await checkDncBatch('o', [])).size).toBe(0)
  })

  it('federal suppression → blocked federal_dnc (no vendor call)', async () => {
    const d = db([{ phone: '+1', source: 'federal' }])
    const r = await checkDncBatch('o', ['+1'], { db: d.client, vendor: noopDncVendor })
    expect(r.get('+1')).toEqual({ status: 'blocked', reason: 'federal_dnc' })
  })

  it('state suppression → blocked state_dnc with state detail', async () => {
    const d = db([{ phone: '+1', source: 'state:NY' }])
    const r = await checkDncBatch('o', ['+1'], { db: d.client, vendor: noopDncVendor })
    expect(r.get('+1')).toEqual({ status: 'blocked', reason: 'state_dnc', detail: { state: 'NY' } })
  })

  it('recent clean ScrubLog (<24h) → clean without a vendor call', async () => {
    const d = db([], ['+1'])
    const r = await checkDncBatch('o', ['+1'], { db: d.client, vendor: noopDncVendor })
    expect(r.get('+1')).toEqual({ status: 'clean' })
  })

  it('live scrub: vendor hit upserts suppression + blocks; clean writes ScrubLog', async () => {
    const d = db()
    const vendor = makeMockDncVendor(new Map([['+block', 'federal']]))
    const r = await checkDncBatch('o', ['+block', '+clean'], { db: d.client, vendor })
    expect(r.get('+block')).toEqual({ status: 'blocked', reason: 'federal_dnc' })
    expect(r.get('+clean')).toEqual({ status: 'clean' })
    expect(d.created).toHaveLength(1) // only the hit upserted
    expect(d.logged).toHaveLength(2) // both logged
  })

  it('noop vendor → fail-closed vendor_error_not_configured', async () => {
    const d = db()
    const r = await checkDncBatch('o', ['+1'], { db: d.client, vendor: noopDncVendor })
    expect(r.get('+1')).toEqual({ status: 'error', reason: 'vendor_error_not_configured' })
  })

  it('vendor throwing (non-429) → fail-closed vendor_error_dnc immediately', async () => {
    const vendor: DncVendorClient = {
      name: 'x', batchSize: 1, rateLimitPerSec: 1,
      async scrubBatch() { throw new VendorError('vendor_error_dnc', 'x', { status: 500 }) },
    }
    const r = await checkDncBatch('o', ['+1'], { db: db().client, vendor })
    expect(r.get('+1')).toEqual({ status: 'error', reason: 'vendor_error_dnc' })
  })

  it('429 retries then succeeds', async () => {
    let calls = 0
    const vendor: DncVendorClient = {
      name: 'x', batchSize: 1, rateLimitPerSec: 1,
      async scrubBatch(phones) {
        calls++
        if (calls < 3) throw new VendorError('vendor_error_dnc', 'x', { status: 429 })
        return { perPhone: phones.map((p) => ({ phone: p, onList: false, list: '' })), checkedAt: 'x' }
      },
    }
    const r = await checkDncBatch('o', ['+1'], { db: db().client, vendor, sleep: noSleep })
    expect(calls).toBe(3)
    expect(r.get('+1')).toEqual({ status: 'clean' })
  })

  it('open circuit → circuit_open_dnc without calling the vendor', async () => {
    const T = 5_000_000
    for (let i = 0; i < 5; i++) recordVendorResult('dnc', false, T + i) // trip it
    let called = false
    const vendor: DncVendorClient = {
      name: 'x', batchSize: 1, rateLimitPerSec: 1,
      async scrubBatch(phones) { called = true; return { perPhone: phones.map((p) => ({ phone: p, onList: false, list: '' })), checkedAt: 'x' } },
    }
    const r = await checkDncBatch('o', ['+1'], { db: db().client, vendor, now: new Date(T + 10) })
    expect(r.get('+1')).toEqual({ status: 'error', reason: 'circuit_open_dnc' })
    expect(called).toBe(false)
  })

  it('phone omitted by the vendor response → fail-closed', async () => {
    const vendor: DncVendorClient = {
      name: 'x', batchSize: 1, rateLimitPerSec: 1,
      async scrubBatch() { return { perPhone: [], checkedAt: 'x' } }, // returns nothing
    }
    const r = await checkDncBatch('o', ['+1'], { db: db().client, vendor })
    expect(r.get('+1')).toEqual({ status: 'error', reason: 'vendor_error_dnc' })
  })

  it('production defaults (no vendor/now/circuit/correlationId) → noop fail-closed', async () => {
    delete process.env.DNC_VENDOR
    resetEnvCache()
    const r = await checkDncBatch('o', ['+1'], { db: db().client }) // all defaults
    expect(r.get('+1')).toEqual({ status: 'error', reason: 'vendor_error_not_configured' })
  })

  it('useCircuit:false skips the breaker entirely', async () => {
    const vendor = makeMockDncVendor(new Map())
    const r = await checkDncBatch('o', ['+1'], { db: db().client, vendor, useCircuit: false })
    expect(r.get('+1')).toEqual({ status: 'clean' })
  })

  it('a non-VendorError throw falls back to vendor_error_dnc', async () => {
    const vendor: DncVendorClient = {
      name: 'x', batchSize: 1, rateLimitPerSec: 1,
      async scrubBatch(): Promise<never> { throw new Error('kaboom') },
    }
    const r = await checkDncBatch('o', ['+1'], { db: db().client, vendor })
    expect(r.get('+1')).toEqual({ status: 'error', reason: 'vendor_error_dnc' })
  })

  it('dedupes duplicate suppression rows for the same phone', async () => {
    const d = db([{ phone: '+1', source: 'federal' }, { phone: '+1', source: 'state:NY' }])
    const r = await checkDncBatch('o', ['+1'], { db: d.client, vendor: noopDncVendor })
    expect(r.get('+1')).toEqual({ status: 'blocked', reason: 'federal_dnc' }) // first row wins
  })

  it('dedupes duplicate vendor rows (hit then clean for the same phone)', async () => {
    const vendor: DncVendorClient = {
      name: 'x', batchSize: 1, rateLimitPerSec: 1,
      async scrubBatch() {
        return { perPhone: [{ phone: '+1', onList: true, list: 'federal' }, { phone: '+1', onList: false, list: '' }], checkedAt: 'x' }
      },
    }
    const r = await checkDncBatch('o', ['+1'], { db: db().client, vendor })
    expect(r.get('+1')).toEqual({ status: 'blocked', reason: 'federal_dnc' }) // hit wins, clean dup skipped
  })

  it('a live state hit logs a check-state row', async () => {
    const d = db()
    const vendor = makeMockDncVendor(new Map([['+st', 'state:NY']]))
    const r = await checkDncBatch('o', ['+st'], { db: d.client, vendor })
    expect(r.get('+st')).toEqual({ status: 'blocked', reason: 'state_dnc', detail: { state: 'NY' } })
    expect(d.logged.some((l) => l.operation === 'check-state' && l.result === 'blocked')).toBe(true)
  })

  it('vendor error with useCircuit:false does not touch the breaker', async () => {
    const vendor: DncVendorClient = {
      name: 'x', batchSize: 1, rateLimitPerSec: 1,
      async scrubBatch(): Promise<never> { throw new VendorError('vendor_error_dnc', 'x') },
    }
    const r = await checkDncBatch('o', ['+1'], { db: db().client, vendor, useCircuit: false })
    expect(r.get('+1')).toEqual({ status: 'error', reason: 'vendor_error_dnc' })
  })

  it('exhausts 429 retries then fails closed (real backoff, default sleep)', async () => {
    const vendor: DncVendorClient = {
      name: 'x', batchSize: 1, rateLimitPerSec: 1,
      async scrubBatch(): Promise<never> { throw new VendorError('vendor_error_dnc', 'x', { status: 429 }) },
    }
    const r = await checkDncBatch('o', ['+1'], { db: db().client, vendor }) // no injected sleep
    expect(r.get('+1')).toEqual({ status: 'error', reason: 'vendor_error_dnc' })
  })
})
