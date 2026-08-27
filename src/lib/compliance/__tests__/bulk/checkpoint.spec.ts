import { describe, it, expect } from 'vitest'
import { loadCheckpoint, saveCheckpoint } from '@/lib/compliance/bulk/checkpoint'

describe('bulk checkpoint', () => {
  it('loadCheckpoint returns the row or null', async () => {
    const row = { lastProcessedContactPhoneId: 'cp5', chunkIndex: 2, processedCount: 5, totalCount: 10, status: 'running', haltReason: null }
    const db = { bulkScrubCheckpoint: { findUnique: async () => row, upsert: async () => ({}) } }
    expect(await loadCheckpoint('o', 'ib', db)).toBe(row)

    const empty = { bulkScrubCheckpoint: { findUnique: async () => null, upsert: async () => ({}) } }
    expect(await loadCheckpoint('o', 'ib', empty)).toBeNull()
  })

  it('saveCheckpoint upserts with the patch on the (org, importBatch) key', async () => {
    let received: any
    const db = { bulkScrubCheckpoint: { findUnique: async () => null, upsert: async (a: any) => ((received = a), {}) } }
    await saveCheckpoint('o', 'ib', { status: 'halted', haltReason: 'circuit_open_dnc' }, db)
    expect(received.where).toEqual({ organizationId_importBatchId: { organizationId: 'o', importBatchId: 'ib' } })
    expect(received.update).toEqual({ status: 'halted', haltReason: 'circuit_open_dnc' })
    expect(received.create).toMatchObject({ organizationId: 'o', importBatchId: 'ib', status: 'halted' })
  })
})
