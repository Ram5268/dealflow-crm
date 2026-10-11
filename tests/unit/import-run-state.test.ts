import { describe, it, expect } from 'vitest'
import {
  RERUN_AFTER_WATCHDOG_MS,
  STALLED_RUN_MS,
  heldBy,
  importRunOf,
  isStalled,
  lastProgressAt,
  rerunWaitMs,
  withImportRun,
} from '@/lib/core-data/importer/batch'
import type { MappingProposal } from '@/lib/core-data/importer/ai-mapping'

// Brief 41.1 (F1): the run id and heartbeat kept in mappingJson, and the two
// timing rules (a minute after a watchdog stop; 10 minutes without progress).
const mapping = { mapping: [], likelyDuplicates: [] } as unknown as MappingProposal
const T0 = Date.parse('2026-10-11T12:00:00Z')

describe('the run kept in mappingJson', () => {
  it('reads back what withImportRun wrote, and nothing from other shapes', () => {
    const json = withImportRun(mapping, { id: 'r1', beatAt: new Date(T0).toISOString() })
    expect(json).toMatchObject({ mapping: [], likelyDuplicates: [] })
    expect(importRunOf(json)).toEqual({ id: 'r1', beatAt: '2026-10-11T12:00:00.000Z' })
    for (const bad of [null, undefined, 'x', 1, {}, { importRun: null }, { importRun: { id: 5, beatAt: 'x' } }, { importRun: { id: 'r' } }]) {
      expect(importRunOf(bad)).toBeNull()
    }
  })

  it('writes are conditional on the run and the status', () => {
    expect(heldBy('ib1', 'r1')).toEqual({ id: 'ib1', status: 'importing', mappingJson: { path: ['importRun', 'id'], equals: 'r1' } })
    expect(heldBy('ib1', 'r1', ['importing', 'failed'])).toMatchObject({ status: { in: ['importing', 'failed'] } })
  })
})

describe('stalled: importing with no progress for 10 minutes', () => {
  const run = (beat: number) => ({ status: 'importing', mappingJson: withImportRun(mapping, { id: 'r', beatAt: new Date(beat).toISOString() }), createdAt: new Date(T0 - 86_400_000) })

  it('counts from the heartbeat', () => {
    expect(STALLED_RUN_MS).toBe(600_000)
    expect(lastProgressAt(run(T0))).toBe(T0)
    expect(isStalled(run(T0), T0 + STALLED_RUN_MS - 1)).toBe(false)
    expect(isStalled(run(T0), T0 + STALLED_RUN_MS)).toBe(true)
  })

  it('without a heartbeat (claimed before run ids), from the upload', () => {
    const legacy = { status: 'importing', mappingJson: { mapping: [] }, createdAt: new Date(T0) }
    expect(lastProgressAt(legacy)).toBe(T0)
    expect(isStalled(legacy, T0 + STALLED_RUN_MS)).toBe(true)
    expect(isStalled({ ...legacy, mappingJson: null }, T0 + 60_000)).toBe(false)
  })

  it('only an importing batch can be stalled', () => {
    for (const status of ['pending', 'mapping_review', 'failed', 'completed']) expect(isStalled({ ...run(T0), status }, T0 + 86_400_000)).toBe(false)
  })
})

describe('a re-run waits a minute after a "stopped responding" failure', () => {
  const failed = (entry: Record<string, unknown>) => ({ errorLog: [{ row: 7, message: 'bad cell' }, { row: 0, message: 'Import stopped: …', ...entry }], completedAt: new Date(T0) })

  it('counts from the watchdog failure', () => {
    expect(RERUN_AFTER_WATCHDOG_MS).toBe(60_000)
    expect(rerunWaitMs(failed({ watchdog: true }), T0)).toBe(60_000)
    expect(rerunWaitMs(failed({ watchdog: true }), T0 + 59_000)).toBe(1_000)
    expect(rerunWaitMs(failed({ watchdog: true }), T0 + 60_000)).toBe(0)
  })

  it('not after any other stop, or while a run is going', () => {
    expect(rerunWaitMs(failed({}), T0)).toBe(0) // time limit, file gone, …
    expect(rerunWaitMs({ ...failed({ watchdog: true }), completedAt: null }, T0)).toBe(0)
    expect(rerunWaitMs({ errorLog: [], completedAt: new Date(T0) }, T0)).toBe(0)
    expect(rerunWaitMs({ errorLog: 'junk', completedAt: new Date(T0) }, T0)).toBe(0)
  })
})
