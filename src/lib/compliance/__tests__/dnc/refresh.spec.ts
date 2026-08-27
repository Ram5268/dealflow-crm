import { describe, it, expect, beforeEach } from 'vitest'
import { runDncRefresh } from '@/lib/compliance/dnc/refresh'
import { makeMockDncVendor } from '@/lib/compliance/dnc/vendors/mock'
import type { DncVendorClient } from '@/lib/compliance/dnc/vendors/types'
import { VendorError } from '@/lib/compliance/errors'
import { recordVendorResult, resetCircuitsForTest } from '@/lib/compliance/bulk/circuitBreaker'

beforeEach(() => resetCircuitsForTest())

function db(phones: string[], deleteCount = 0) {
  const created: any[] = []
  const deleted: any[] = []
  const logged: any[] = []
  return {
    created,
    deleted,
    logged,
    client: {
      contactPhone: { findMany: async () => phones.map((phone) => ({ phone })) },
      dncSuppression: {
        createMany: async (a: any) => (created.push(...a.data), { count: a.data.length }),
        deleteMany: async (a: any) => (deleted.push(a), { count: deleteCount }),
      },
      scrubLog: { createMany: async (a: any) => (logged.push(...a.data), { count: a.data.length }) },
    },
  }
}

describe('runDncRefresh', () => {
  it('upserts hits and removes now-clean federal/state rows', async () => {
    const d = db(['+a', '+b'], 1)
    const vendor = makeMockDncVendor(new Map([['+a', 'federal']]))
    const out = await runDncRefresh('o', { db: d.client, vendor, chunkSize: 10 })
    expect(out.scanned).toBe(2)
    expect(out.blocked).toBe(1)
    expect(out.removed).toBe(1)
    expect(d.created).toHaveLength(1) // +a upserted
    // deleteMany scopes to federal/state only (internal never removed).
    expect(d.deleted[0].where.OR).toEqual([{ source: 'federal' }, { source: { startsWith: 'state:' } }])
  })

  it('halts when the circuit is already open', async () => {
    const T = 8_000_000
    for (let i = 0; i < 5; i++) recordVendorResult('dnc', false, T + i)
    const d = db(['+a'])
    const vendor = makeMockDncVendor()
    const out = await runDncRefresh('o', { db: d.client, vendor, chunkSize: 1, now: new Date(T + 10) })
    expect(out.halted).toBe(true)
  })

  it('on vendor error, logs an error row and leaves suppressions untouched', async () => {
    const d = db(['+a'])
    const vendor: DncVendorClient = {
      name: 'x', batchSize: 10, rateLimitPerSec: 1,
      async scrubBatch() { throw new VendorError('vendor_error_dnc', 'x') },
    }
    const out = await runDncRefresh('o', { db: d.client, vendor, chunkSize: 10 })
    expect(d.created).toHaveLength(0)
    expect(d.logged.some((l) => l.result === 'error')).toBe(true)
    expect(out.blocked).toBe(0)
  })
})
