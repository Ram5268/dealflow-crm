import { describe, it, expect, beforeEach } from 'vitest'
import {
  validateConfirmInput,
  confirmPolicy,
  isValidIana,
  PolicyValidationError,
} from '@/lib/compliance/policy/confirm'
import { isPolicyConfirmed } from '@/lib/compliance/policy/gate'
import { resetAllCaches } from '@/lib/compliance/caches'

const VALID = {
  timezone: 'America/New_York',
  earliestHour: 9,
  latestHour: 20,
  allowedDaysOfWeek: [1, 2, 3, 4, 5],
  policyConfirmedBy: 'user:ryan@dealflow|counsel:jdoe|date:2026-09-01',
}

beforeEach(() => resetAllCaches())

describe('isValidIana', () => {
  it('accepts real zones, rejects junk', () => {
    expect(isValidIana('America/New_York')).toBe(true)
    expect(isValidIana('Etc/Weird')).toBe(false)
    expect(isValidIana('')).toBe(false)
  })
})

describe('validateConfirmInput', () => {
  it('accepts a valid input', () => {
    expect(validateConfirmInput(VALID)).toBeNull()
  })
  it('rejects earliestHour out of range', () => {
    expect(validateConfirmInput({ ...VALID, earliestHour: -1 })).toMatch(/earliestHour/)
    expect(validateConfirmInput({ ...VALID, earliestHour: 24 })).toMatch(/earliestHour/)
  })
  it('rejects latestHour out of range', () => {
    expect(validateConfirmInput({ ...VALID, latestHour: 25 })).toMatch(/latestHour/)
    expect(validateConfirmInput({ ...VALID, latestHour: 0 })).toMatch(/latestHour/)
  })
  it('rejects earliestHour >= latestHour', () => {
    expect(validateConfirmInput({ ...VALID, earliestHour: 20, latestHour: 20 })).toMatch(/must be </)
  })
  it('rejects an empty or out-of-range allowedDaysOfWeek', () => {
    expect(validateConfirmInput({ ...VALID, allowedDaysOfWeek: [] })).toMatch(/allowedDaysOfWeek/)
    expect(validateConfirmInput({ ...VALID, allowedDaysOfWeek: [7] })).toMatch(/allowedDaysOfWeek/)
  })
  it('rejects a short policyConfirmedBy (< 20 chars)', () => {
    expect(validateConfirmInput({ ...VALID, policyConfirmedBy: 'too short' })).toMatch(/policyConfirmedBy/)
  })
  it('rejects an invalid IANA timezone', () => {
    expect(validateConfirmInput({ ...VALID, timezone: 'Etc/Weird' })).toMatch(/IANA/)
  })
})

describe('confirmPolicy', () => {
  const makeDb = () => {
    const calls: any[] = []
    return {
      calls,
      db: {
        callingWindowConfig: {
          upsert: async (args: any) => {
            calls.push(args)
            return {
              timezone: args.where.organizationId_timezone.timezone,
              earliestHour: args.create.earliestHour,
              latestHour: args.create.latestHour,
              allowedDaysOfWeek: args.create.allowedDaysOfWeek,
              policyConfirmedBy: args.create.policyConfirmedBy,
              policyConfirmedAt: args.create.policyConfirmedAt,
            }
          },
        },
      },
    }
  }

  it('throws PolicyValidationError on invalid input (before any write)', async () => {
    const { db, calls } = makeDb()
    await expect(confirmPolicy('o', { ...VALID, policyConfirmedBy: 'short' }, { db })).rejects.toThrow(
      PolicyValidationError
    )
    expect(calls.length).toBe(0)
  })

  it('upserts, sets policyConfirmedAt, and invalidates the gate cache', async () => {
    const { db } = makeDb()
    const now = new Date('2026-09-01T12:00:00Z')

    // Prime the gate cache with an UNCONFIRMED verdict for this tz.
    const gateDb = { callingWindowConfig: { findUnique: async () => null } }
    await isPolicyConfirmed('o', VALID.timezone, { db: gateDb, useCache: true })

    const row = await confirmPolicy('o', VALID, { db, now })
    expect(row.policyConfirmedAt).toBe(now)

    // After confirm, the cache was invalidated: the gate re-reads (now confirmed).
    const gateDb2 = { callingWindowConfig: { findUnique: async () => ({ ...VALID, policyConfirmedAt: now }) } }
    const verdict = await isPolicyConfirmed('o', VALID.timezone, { db: gateDb2, useCache: true })
    expect(verdict.confirmed).toBe(true)
  })

  it('defaults policyConfirmedAt to now when not supplied', async () => {
    const { db } = makeDb()
    const before = Date.now()
    const row = await confirmPolicy('o', VALID, { db }) // no `now`
    expect(row.policyConfirmedAt).toBeInstanceOf(Date)
    expect((row.policyConfirmedAt as Date).getTime()).toBeGreaterThanOrEqual(before)
  })
})
