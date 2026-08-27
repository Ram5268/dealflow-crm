import { describe, it, expect } from 'vitest'
import { z } from 'zod'
import { runCallableNow } from '@/lib/compliance/scrub/callableNow'
import type { CallableNowDeps, LoadedPhone } from '@/lib/compliance/scrub/callableNow'
import { reasonCodeSchema, REASON_CODES } from '../../http/reason-codes'

// Gate 2 — the callable-now wire shape. Locked: every result carries BOTH
// contactPhoneId AND phone; reasons[] is drawn from REASON_CODES; field names
// are camelCase. Agent A consumes `phone`; Agent B consumes `contactPhoneId`.

const resultSchema = z
  .object({
    contactPhoneId: z.string(),
    phone: z.string(),
    callable: z.boolean(),
    reasons: z.array(reasonCodeSchema),
    reasonDetails: z.record(z.string(), z.unknown()).optional(),
  })
  .strict()
const responseSchema = z.object({ results: z.array(resultSchema) }).strict()

const CONFIRMED = {
  timezone: 'America/New_York',
  earliestHour: 9,
  latestHour: 20,
  allowedDaysOfWeek: [1, 2, 3, 4, 5],
  policyConfirmedBy: 'user:ryan|counsel:jdoe|date:2026-09-01',
  policyConfirmedAt: new Date(),
}

function depsFor(
  entries: Record<string, LoadedPhone>,
  over: Partial<CallableNowDeps> = {}
): CallableNowDeps {
  return {
    orgId: 'org_test',
    correlationId: '11111111-1111-4111-8111-111111111111',
    now: new Date('2026-01-05T06:00:00Z'), // Monday 01:00 EST — outside hours
    loadContactPhones: async (ids) => {
      const m = new Map<string, LoadedPhone>()
      for (const id of ids) if (entries[id]) m.set(id, entries[id])
      return m
    },
    internalDncHits: async () => new Set<string>(),
    isPolicyConfirmed: async () => ({ confirmed: true, config: CONFIRMED }),
    checkHoliday: async () => ({ blocked: false }),
    persist: async () => {},
    ...over,
  }
}

describe('callable-now response contract', () => {
  it('conforms to the locked shape and only emits REASON_CODES', async () => {
    const entries: Record<string, LoadedPhone> = {
      ok: { phone: '+12125550001', timezone: 'America/New_York', addressState: 'NY' },
      notz: { phone: '+12125550002', timezone: null, addressState: null },
    }
    const res = await runCallableNow({ contactPhoneIds: ['ok', 'notz', 'missing'] }, depsFor(entries))

    // Whole-envelope validation (strict: rejects snake_case / extra keys).
    expect(() => responseSchema.parse(res)).not.toThrow()

    for (const r of res.results) {
      expect(r).toHaveProperty('contactPhoneId')
      expect(r).toHaveProperty('phone')
      for (const reason of r.reasons) expect(REASON_CODES).toContain(reason)
    }
    // phone_missing echoes id with empty phone.
    expect(res.results[2]).toMatchObject({ contactPhoneId: 'missing', phone: '' })
  })

  it('produces a spread of REASON_CODES across scenarios (all valid members)', async () => {
    const seen = new Set<string>()
    const push = (rs: string[]) => rs.forEach((r) => seen.add(r))

    // timezone_unresolved
    push(
      (await runCallableNow({ contactPhoneIds: ['a'] }, depsFor({ a: { phone: '+1', timezone: null, addressState: null } })))
        .results[0].reasons
    )
    // policy_unconfirmed
    push(
      (
        await runCallableNow(
          { contactPhoneIds: ['a'] },
          depsFor({ a: { phone: '+1', timezone: 'America/New_York', addressState: 'NY' } }, {
            isPolicyConfirmed: async () => ({ confirmed: false }),
          })
        )
      ).results[0].reasons
    )
    // internal_dnc
    push(
      (
        await runCallableNow(
          { contactPhoneIds: ['a'] },
          depsFor({ a: { phone: '+1', timezone: 'America/New_York', addressState: 'NY' } }, {
            internalDncHits: async () => new Set(['+1']),
          })
        )
      ).results[0].reasons
    )
    // outside_calling_window_hour (deps.now is 01:00 EST)
    push(
      (
        await runCallableNow(
          { contactPhoneIds: ['a'] },
          depsFor({ a: { phone: '+1', timezone: 'America/New_York', addressState: 'NY' } })
        )
      ).results[0].reasons
    )
    // holiday_federal
    push(
      (
        await runCallableNow(
          { contactPhoneIds: ['a'], atInstant: '2026-01-05T17:00:00Z' },
          depsFor({ a: { phone: '+1', timezone: 'America/New_York', addressState: 'NY' } }, {
            checkHoliday: async () => ({ blocked: true, reason: 'holiday_federal', detail: { name: 'X' } }),
          })
        )
      ).results[0].reasons
    )
    // phone_missing
    push((await runCallableNow({ contactPhoneIds: ['x'] }, depsFor({}))).results[0].reasons)

    expect(seen.size).toBeGreaterThanOrEqual(5)
    for (const r of seen) expect(REASON_CODES).toContain(r)
  })
})
