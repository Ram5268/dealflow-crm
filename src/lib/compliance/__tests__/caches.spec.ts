import { describe, it, expect, beforeEach } from 'vitest'
import {
  TtlCache,
  policyCacheKey,
  holidayCacheKey,
  configCache,
  policyGateCache,
  invalidatePolicyCaches,
  resetAllCaches,
} from '@/lib/compliance/caches'

beforeEach(() => resetAllCaches())

describe('TtlCache', () => {
  it('get/set/delete/clear/size', () => {
    const c = new TtlCache<{ v: number }>(1000, 10)
    expect(c.get('a')).toBeUndefined()
    c.set('a', { v: 1 })
    expect(c.get('a')).toEqual({ v: 1 })
    expect(c.size).toBe(1)
    c.delete('a')
    expect(c.get('a')).toBeUndefined()
    c.set('b', { v: 2 })
    c.clear()
    expect(c.size).toBe(0)
  })
})

describe('cache keys', () => {
  it('policyCacheKey and holidayCacheKey (null state -> *)', () => {
    expect(policyCacheKey('o', 'America/New_York')).toBe('o::America/New_York')
    expect(holidayCacheKey('o', '2027-07-04', 'NY')).toBe('o::2027-07-04::NY')
    expect(holidayCacheKey('o', '2027-07-04', null)).toBe('o::2027-07-04::*')
  })
})

describe('invalidatePolicyCaches', () => {
  it('scoped invalidation deletes just that key', () => {
    const key = policyCacheKey('o', 'America/New_York')
    configCache.set(key, { value: 1 })
    policyGateCache.set(key, { confirmed: true })
    invalidatePolicyCaches('o', 'America/New_York')
    expect(configCache.get(key)).toBeUndefined()
    expect(policyGateCache.get(key)).toBeUndefined()
  })

  it('full clear when no key given', () => {
    policyGateCache.set(policyCacheKey('o', 'A'), { confirmed: true })
    policyGateCache.set(policyCacheKey('o', 'B'), { confirmed: true })
    invalidatePolicyCaches()
    expect(policyGateCache.size).toBe(0)
  })
})
