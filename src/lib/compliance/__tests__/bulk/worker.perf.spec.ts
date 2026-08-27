import { describe, it, expect, beforeEach } from 'vitest'
import { runBulkScrub } from '@/lib/compliance/bulk/worker'
import type { DncStatus } from '@/lib/compliance/dnc/check'
import type { LitigatorStatus } from '@/lib/compliance/litigator/check'
import { resetCircuitsForTest } from '@/lib/compliance/bulk/circuitBreaker'

beforeEach(() => resetCircuitsForTest())

// The 25k target is < 30 min against a mock vendor (~50ms/batch of 250 =>
// 100 batches => ~5s of vendor time). Here we prove the WORKER overhead
// (enumeration, chunking, checkpoint writes) is linear and negligible: 5000
// phones with instant mock checks must finish in well under a second, so the
// wall-clock is dominated by vendor latency, not our loop.
describe('bulk-scrub worker overhead', () => {
  it('5000 phones, 250/chunk, resolves quickly with instant mocks', async () => {
    const phones = Array.from({ length: 5000 }, (_, i) => ({ id: `cp${String(i).padStart(5, '0')}`, phone: `+1555${String(i).padStart(7, '0')}` }))
    const db = {
      contactPhone: { findMany: async () => phones },
      bulkScrubCheckpoint: { findUnique: async () => null, upsert: async () => ({}) },
    }
    const dnc = async (_o: string, ps: string[]) => new Map<string, DncStatus>(ps.map((p) => [p, { status: 'clean' }]))
    const lit = async (_o: string, ps: string[]) => new Map<string, LitigatorStatus>(ps.map((p) => [p, { status: 'clean' }]))

    const t0 = performance.now()
    const out = await runBulkScrub({ orgId: 'o', importBatchId: 'ib' }, { db, checkDnc: dnc, checkLitigator: lit, chunkSize: 250 })
    const elapsed = performance.now() - t0

    expect(out).toMatchObject({ totalCount: 5000, processedCount: 5000, status: 'completed' })
    expect(elapsed).toBeLessThan(2000)
  })
})
