import { describe, it, expect } from 'vitest'
import { runCallableNow } from '@/lib/compliance/scrub/callableNow'
import type { CallableNowDeps, LoadedPhone } from '@/lib/compliance/scrub/callableNow'

// M1 hot-path budget: p95 < 150ms warm-cache (§7.2). With all data-access deps
// resolved in-memory (mirrors warm LRU caches + a single batch findMany), the
// pipeline itself must be well under budget. This guards against an accidental
// per-phone async explosion or O(n^2) regression.

const CONFIRMED = {
  timezone: 'America/New_York',
  earliestHour: 9,
  latestHour: 20,
  allowedDaysOfWeek: [1, 2, 3, 4, 5],
  policyConfirmedBy: 'user:ryan|counsel:jdoe|date:2026-09-01',
  policyConfirmedAt: new Date(),
}

function warmDeps(entries: Record<string, LoadedPhone>): CallableNowDeps {
  return {
    orgId: 'org_test',
    correlationId: '11111111-1111-4111-8111-111111111111',
    now: new Date('2026-01-05T17:00:00Z'),
    loadContactPhones: async (ids) => {
      const m = new Map<string, LoadedPhone>()
      for (const id of ids) if (entries[id]) m.set(id, entries[id])
      return m
    },
    internalDncHits: async () => new Set<string>(),
    isPolicyConfirmed: async () => ({ confirmed: true, config: CONFIRMED }),
    checkHoliday: async () => ({ blocked: false }),
    holidayFreshDays: async () => 1,
    persist: async () => {},
  }
}

describe('callable-now p95 latency (warm)', () => {
  it('100 single-id calls p95 < 150ms', async () => {
    const entries: Record<string, LoadedPhone> = {
      cp: { phone: '+12125550001', timezone: 'America/New_York', addressState: 'NY' },
    }
    const deps = warmDeps(entries)

    const samples: number[] = []
    for (let i = 0; i < 100; i++) {
      const t0 = performance.now()
      await runCallableNow({ contactPhoneIds: ['cp'] }, deps)
      samples.push(performance.now() - t0)
    }
    samples.sort((a, b) => a - b)
    const p95 = samples[Math.floor(samples.length * 0.95)]
    expect(p95).toBeLessThan(150)
  })

  it('a full 100-id batch resolves in one pass well under budget', async () => {
    const entries: Record<string, LoadedPhone> = {}
    const ids: string[] = []
    for (let i = 0; i < 100; i++) {
      const id = `cp_${i}`
      ids.push(id)
      entries[id] = { phone: `+1212555${String(1000 + i)}`, timezone: 'America/New_York', addressState: 'NY' }
    }
    const deps = warmDeps(entries)
    const t0 = performance.now()
    const { results } = await runCallableNow({ contactPhoneIds: ids }, deps)
    const elapsed = performance.now() - t0
    expect(results).toHaveLength(100)
    expect(elapsed).toBeLessThan(150)
  })
})
