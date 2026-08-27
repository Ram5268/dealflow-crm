import { LRUCache } from 'lru-cache'

// In-process LRU/TTL caches for the callable-now hot path (called inline by
// Agent B before every dial; p95 < 150ms target at M1). No Redis — single
// Node worker per Vercel/Railway process; a 5-minute TTL bounds staleness.
//
// Caches are invalidated eagerly on POST /api/compliance/policy/confirm so a
// freshly-confirmed policy is visible on the very next callable-now without
// waiting for the TTL to lapse.
//
// SAFETY: caches only ever hold POSITIVE, already-computed facts (a confirmed
// config, a resolved holiday set). They never cache a "callable: true"
// decision — every dial is re-evaluated. A cache miss re-reads the DB; a cache
// bug can only cost latency, never a wrongful call.

const TTL_MS = 5 * 60 * 1000 // 5 minutes
const MAX_ENTRIES = 5000

export class TtlCache<V extends {}> {
  private lru: LRUCache<string, V>
  constructor(ttlMs: number = TTL_MS, max: number = MAX_ENTRIES) {
    this.lru = new LRUCache<string, V>({ max, ttl: ttlMs })
  }
  get(key: string): V | undefined {
    return this.lru.get(key)
  }
  set(key: string, value: V): void {
    this.lru.set(key, value)
  }
  delete(key: string): void {
    this.lru.delete(key)
  }
  clear(): void {
    this.lru.clear()
  }
  get size(): number {
    return this.lru.size
  }
}

export function policyCacheKey(orgId: string, timezone: string): string {
  return `${orgId}::${timezone}`
}

export function holidayCacheKey(orgId: string, localDate: string, state: string | null): string {
  return `${orgId}::${localDate}::${state ?? '*'}`
}

// Confirmed CallingWindowConfig rows and the derived policy-gate verdict share
// the (orgId, timezone) key space and are invalidated together on confirm.
export const configCache = new TtlCache<{ value: unknown }>()
export const policyGateCache = new TtlCache<{ confirmed: boolean; config?: unknown }>()
export const holidaySetCache = new TtlCache<{ value: unknown }>()

// Called by POST /api/compliance/policy/confirm after a write.
export function invalidatePolicyCaches(orgId?: string, timezone?: string): void {
  if (orgId && timezone) {
    const key = policyCacheKey(orgId, timezone)
    configCache.delete(key)
    policyGateCache.delete(key)
    return
  }
  configCache.clear()
  policyGateCache.clear()
}

// Test seam: wipe every cache between cases.
export function resetAllCaches(): void {
  configCache.clear()
  policyGateCache.clear()
  holidaySetCache.clear()
}
