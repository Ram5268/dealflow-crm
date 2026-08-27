import { describe, it, expect, beforeEach } from 'vitest'
import { runBulkScrub } from '@/lib/compliance/bulk/worker'
import type { DncStatus } from '@/lib/compliance/dnc/check'
import type { LitigatorStatus } from '@/lib/compliance/litigator/check'
import { recordVendorResult, resetCircuitsForTest } from '@/lib/compliance/bulk/circuitBreaker'

beforeEach(() => resetCircuitsForTest())

function workerDb(phones: Array<{ id: string; phone: string }>, checkpoint: any = null) {
  const saves: any[] = []
  return {
    saves,
    client: {
      contactPhone: { findMany: async () => phones },
      bulkScrubCheckpoint: {
        findUnique: async () => checkpoint,
        upsert: async (a: any) => (saves.push(a.update), {}),
      },
    },
  }
}

const allClean = async (_o: string, ps: string[]) => new Map<string, DncStatus>(ps.map((p) => [p, { status: 'clean' }]))
const litClean = async (_o: string, ps: string[]) => new Map<string, LitigatorStatus>(ps.map((p) => [p, { status: 'clean' }]))

describe('runBulkScrub', () => {
  it('processes all phones in chunks and completes', async () => {
    const phones = ['cp1', 'cp2', 'cp3', 'cp4', 'cp5'].map((id) => ({ id, phone: `+${id}` }))
    const d = workerDb(phones)
    const out = await runBulkScrub({ orgId: 'o', importBatchId: 'ib' }, { db: d.client, checkDnc: allClean, checkLitigator: litClean, chunkSize: 2 })
    expect(out).toMatchObject({ totalCount: 5, processedCount: 5, status: 'completed' })
    expect(d.saves.at(-1)).toMatchObject({ status: 'completed' })
  })

  it('resumes from the checkpoint (no re-scrub of processed ids)', async () => {
    const phones = ['cp1', 'cp2', 'cp3', 'cp4', 'cp5'].map((id) => ({ id, phone: `+${id}` }))
    const scrubbed: string[] = []
    const trackingDnc = async (_o: string, ps: string[]) => (scrubbed.push(...ps), new Map<string, DncStatus>(ps.map((p) => [p, { status: 'clean' as const }])))
    const d = workerDb(phones, { lastProcessedContactPhoneId: 'cp2', chunkIndex: 1, processedCount: 2, totalCount: 5, status: 'running', haltReason: null })
    const out = await runBulkScrub({ orgId: 'o', importBatchId: 'ib' }, { db: d.client, checkDnc: trackingDnc, checkLitigator: litClean, chunkSize: 2 })
    expect(scrubbed).toEqual(['+cp3', '+cp4', '+cp5']) // cp1, cp2 skipped
    expect(out.processedCount).toBe(5)
  })

  it('counts blocked phones', async () => {
    const phones = ['cp1', 'cp2'].map((id) => ({ id, phone: `+${id}` }))
    const d = workerDb(phones)
    const dnc = async (_o: string, ps: string[]) =>
      new Map<string, DncStatus>(ps.map((p) => [p, p === '+cp1' ? { status: 'blocked', reason: 'federal_dnc' } : { status: 'clean' }]))
    const out = await runBulkScrub({ orgId: 'o', importBatchId: 'ib' }, { db: d.client, checkDnc: dnc, checkLitigator: litClean, chunkSize: 10 })
    expect(out.blockedCount).toBe(1)
  })

  it('halts when the DNC circuit is open', async () => {
    const T = 7_000_000
    for (let i = 0; i < 5; i++) recordVendorResult('dnc', false, T + i)
    const phones = ['cp1', 'cp2'].map((id) => ({ id, phone: `+${id}` }))
    const d = workerDb(phones)
    const out = await runBulkScrub(
      { orgId: 'o', importBatchId: 'ib' },
      { db: d.client, checkDnc: allClean, checkLitigator: litClean, chunkSize: 1, now: new Date(T + 10) }
    )
    expect(out.status).toBe('halted')
    expect(out.haltReason).toBe('circuit_open_dnc')
    expect(d.saves.at(-1)).toMatchObject({ status: 'halted' })
  })
})
