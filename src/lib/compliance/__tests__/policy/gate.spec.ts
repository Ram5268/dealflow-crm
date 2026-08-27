import { describe, it, expect, beforeEach } from 'vitest'
import { classifyPolicy, isPolicyConfirmed } from '@/lib/compliance/policy/gate'
import { invalidatePolicyCaches, resetAllCaches } from '@/lib/compliance/caches'

const confirmedRow = {
  timezone: 'America/New_York',
  earliestHour: 9,
  latestHour: 20,
  allowedDaysOfWeek: [1, 2, 3, 4, 5],
  policyConfirmedBy: 'user:ryan@dealflow|counsel:jdoe|date:2026-09-01',
  policyConfirmedAt: new Date(),
}

beforeEach(() => resetAllCaches())

describe('classifyPolicy (pure)', () => {
  it('no row => unconfirmed', () => {
    expect(classifyPolicy(null)).toEqual({ confirmed: false })
    expect(classifyPolicy(undefined)).toEqual({ confirmed: false })
  })
  it('row with null policyConfirmedBy => unconfirmed', () => {
    expect(classifyPolicy({ ...confirmedRow, policyConfirmedBy: null })).toEqual({ confirmed: false })
  })
  it('confirmed row => confirmed with config', () => {
    const r = classifyPolicy(confirmedRow)
    expect(r.confirmed).toBe(true)
    expect(r.config).toBe(confirmedRow)
  })
})

describe('isPolicyConfirmed', () => {
  it('returns unconfirmed when no config row', async () => {
    const db = { callingWindowConfig: { findUnique: async () => null } }
    expect(await isPolicyConfirmed('o', 'America/New_York', { db })).toEqual({ confirmed: false })
  })

  it('returns confirmed for a confirmed row', async () => {
    const db = { callingWindowConfig: { findUnique: async () => confirmedRow } }
    const r = await isPolicyConfirmed('o', 'America/New_York', { db })
    expect(r.confirmed).toBe(true)
  })

  it('serves from cache on the second call, and re-reads after invalidation', async () => {
    let calls = 0
    const db = {
      callingWindowConfig: {
        findUnique: async () => {
          calls++
          return confirmedRow
        },
      },
    }
    await isPolicyConfirmed('o', 'America/New_York', { db, useCache: true })
    await isPolicyConfirmed('o', 'America/New_York', { db, useCache: true })
    expect(calls).toBe(1)

    invalidatePolicyCaches('o', 'America/New_York')
    await isPolicyConfirmed('o', 'America/New_York', { db, useCache: true })
    expect(calls).toBe(2)
  })
})
