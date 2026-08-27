import { describe, it, expect } from 'vitest'
import { checkMobileLine } from '@/lib/compliance/mobileLine/check'

const NOW = new Date('2026-09-01T00:00:00Z')
const fresh = new Date('2026-12-01T00:00:00Z')
const expired = new Date('2026-01-01T00:00:00Z')

function db(row: any) {
  const logs: any[] = []
  const upserts: any[] = []
  return {
    logs,
    upserts,
    client: {
      mobileLineCache: {
        findUnique: async () => row,
        upsert: async (a: any) => (upserts.push(a), {}),
      },
      scrubLog: { create: async (a: any) => (logs.push(a.data), {}) },
    },
  }
}

describe('checkMobileLine (advisory)', () => {
  it('fresh cache → returns cached, no lookup', async () => {
    let looked = false
    const d = db({ lineType: 'mobile', carrier: 'VZ', expiresAt: fresh })
    const r = await checkMobileLine('o', '+1', { db: d.client, now: NOW, lookup: async () => ((looked = true), { lineType: 'x' }) })
    expect(r).toEqual({ lineType: 'mobile', carrier: 'VZ', stale: false, error: false })
    expect(looked).toBe(false)
  })

  it('expired cache + live success → upserts fresh', async () => {
    const d = db({ lineType: 'landline', carrier: null, expiresAt: expired })
    const r = await checkMobileLine('o', '+1', { db: d.client, now: NOW, lookup: async () => ({ lineType: 'mobile', carrier: 'ATT' }) })
    expect(r).toMatchObject({ lineType: 'mobile', carrier: 'ATT', stale: false })
    expect(d.upserts).toHaveLength(1)
  })

  it('expired cache + live error → serves stale (advisory, not fail-closed)', async () => {
    const d = db({ lineType: 'landline', carrier: null, expiresAt: expired })
    const r = await checkMobileLine('o', '+1', { db: d.client, now: NOW, lookup: async () => { throw new Error('twilio down') } })
    expect(r).toEqual({ lineType: 'landline', carrier: undefined, stale: true, error: false })
  })

  it('no row + live success → upserts', async () => {
    const d = db(null)
    const r = await checkMobileLine('o', '+1', { db: d.client, now: NOW, lookup: async () => ({ lineType: 'voip' }) })
    expect(r).toMatchObject({ lineType: 'voip', error: false })
    expect(d.upserts).toHaveLength(1)
  })

  it('no row + live error → advisory error, NEVER blocks', async () => {
    const d = db(null)
    const r = await checkMobileLine('o', '+1', { db: d.client, now: NOW, lookup: async () => { throw new Error('boom') } })
    expect(r).toEqual({ lineType: null, stale: false, error: true })
    expect(d.logs.at(-1)).toMatchObject({ operation: 'check-mobile-line', result: 'error' })
  })
})
