import { describe, it, expect } from 'vitest'
import { runCallableNow, CALLABLE_NOW_MAX } from '@/lib/compliance/scrub/callableNow'
import type { CallableNowDeps, LoadedPhone } from '@/lib/compliance/scrub/callableNow'
import { BatchTooLargeError } from '@/lib/compliance/errors'

const CID = '11111111-1111-4111-8111-111111111111'
const MON_NOON_EST = new Date('2026-01-05T17:00:00Z') // Monday 12:00 EST — in window
const CONFIRMED = {
  timezone: 'America/New_York',
  earliestHour: 9,
  latestHour: 20,
  allowedDaysOfWeek: [1, 2, 3, 4, 5],
  policyConfirmedBy: 'user:ryan|counsel:jdoe|date:2026-09-01',
  policyConfirmedAt: new Date(),
}

function loaded(entries: Record<string, LoadedPhone>) {
  return async (ids: string[]) => {
    const m = new Map<string, LoadedPhone>()
    for (const id of ids) if (entries[id]) m.set(id, entries[id])
    return m
  }
}

function makeDeps(overrides: Partial<CallableNowDeps> = {}) {
  const persistCalls: Array<{ logs: any[]; event: any }> = []
  const deps: CallableNowDeps = {
    orgId: 'org_test',
    correlationId: CID,
    now: overrides.now ?? MON_NOON_EST,
    loadContactPhones: overrides.loadContactPhones ?? (async () => new Map()),
    internalDncHits: overrides.internalDncHits ?? (async () => new Set<string>()),
    isPolicyConfirmed: overrides.isPolicyConfirmed ?? (async () => ({ confirmed: true, config: CONFIRMED })),
    checkHoliday: overrides.checkHoliday ?? (async () => ({ blocked: false })),
    holidayFreshDays: overrides.holidayFreshDays,
    persist: overrides.persist ?? (async (_o, logs, event) => void persistCalls.push({ logs, event })),
  }
  return { deps, persistCalls }
}

const NY = (over: Partial<LoadedPhone> = {}): LoadedPhone => ({
  phone: '+12125550001',
  timezone: 'America/New_York',
  addressState: 'NY',
  ...over,
})

describe('runCallableNow — fail-closed matrix', () => {
  it('phone_missing: unknown contactPhoneId -> callable:false, phone ""', async () => {
    const { deps } = makeDeps({ loadContactPhones: loaded({}) })
    const { results } = await runCallableNow({ contactPhoneIds: ['nope'] }, deps)
    expect(results[0]).toMatchObject({ contactPhoneId: 'nope', phone: '', callable: false, reasons: ['phone_missing'] })
  })

  it('timezone_unresolved: null timezone -> callable:false', async () => {
    const { deps } = makeDeps({ loadContactPhones: loaded({ a: NY({ timezone: null }) }) })
    const { results } = await runCallableNow({ contactPhoneIds: ['a'] }, deps)
    expect(results[0]).toMatchObject({ callable: false, reasons: ['timezone_unresolved'], phone: '+12125550001' })
  })

  it('policy_unconfirmed: gate unconfirmed -> callable:false', async () => {
    const { deps } = makeDeps({
      loadContactPhones: loaded({ a: NY() }),
      isPolicyConfirmed: async () => ({ confirmed: false }),
    })
    const { results } = await runCallableNow({ contactPhoneIds: ['a'] }, deps)
    expect(results[0].reasons).toEqual(['policy_unconfirmed'])
    expect(results[0].callable).toBe(false)
  })

  it('internal_dnc: phone on internal list -> callable:false', async () => {
    const { deps } = makeDeps({
      loadContactPhones: loaded({ a: NY() }),
      internalDncHits: async () => new Set(['+12125550001']),
    })
    const { results } = await runCallableNow({ contactPhoneIds: ['a'] }, deps)
    expect(results[0].reasons).toEqual(['internal_dnc'])
  })

  it('outside_calling_window_hour: pre-9am local -> callable:false', async () => {
    const { deps } = makeDeps({ loadContactPhones: loaded({ a: NY() }), now: new Date('2026-01-05T06:00:00Z') })
    const { results } = await runCallableNow({ contactPhoneIds: ['a'] }, deps)
    expect(results[0].reasons).toEqual(['outside_calling_window_hour'])
  })

  it('outside_calling_window_day: Saturday in-hours -> callable:false', async () => {
    const { deps } = makeDeps({ loadContactPhones: loaded({ a: NY() }), now: new Date('2026-01-03T17:00:00Z') })
    const { results } = await runCallableNow({ contactPhoneIds: ['a'] }, deps)
    expect(results[0].reasons).toEqual(['outside_calling_window_day'])
  })

  it('timezone_invalid: bad IANA on the row -> callable:false', async () => {
    const { deps } = makeDeps({ loadContactPhones: loaded({ a: NY({ timezone: 'Etc/Weird' }) }) })
    const { results } = await runCallableNow({ contactPhoneIds: ['a'] }, deps)
    expect(results[0].reasons).toEqual(['timezone_invalid'])
  })

  it('holiday_federal: blocked with reasonDetails.holiday_federal', async () => {
    const { deps } = makeDeps({
      loadContactPhones: loaded({ a: NY() }),
      checkHoliday: async () => ({ blocked: true, reason: 'holiday_federal', detail: { name: 'Independence Day' } }),
    })
    const { results } = await runCallableNow({ contactPhoneIds: ['a'] }, deps)
    expect(results[0].reasons).toEqual(['holiday_federal'])
    expect(results[0].reasonDetails).toEqual({ holiday_federal: { name: 'Independence Day' } })
  })

  it('holiday_state: blocked with reasonDetails.holiday_state', async () => {
    const { deps } = makeDeps({
      loadContactPhones: loaded({ a: NY() }),
      checkHoliday: async () => ({ blocked: true, reason: 'holiday_state', detail: { state: 'MA', name: "Patriots' Day" } }),
    })
    const { results } = await runCallableNow({ contactPhoneIds: ['a'] }, deps)
    expect(results[0].reasonDetails).toEqual({ holiday_state: { state: 'MA', name: "Patriots' Day" } })
  })

  it('holiday_table_stale: blocked, no reasonDetails', async () => {
    const { deps } = makeDeps({
      loadContactPhones: loaded({ a: NY() }),
      checkHoliday: async () => ({ blocked: true, reason: 'holiday_table_stale' }),
    })
    const { results } = await runCallableNow({ contactPhoneIds: ['a'] }, deps)
    expect(results[0].reasons).toEqual(['holiday_table_stale'])
    expect(results[0].reasonDetails).toBeUndefined()
  })

  it('callable:true when every gate passes', async () => {
    const { deps } = makeDeps({ loadContactPhones: loaded({ a: NY() }) })
    const { results } = await runCallableNow({ contactPhoneIds: ['a'] }, deps)
    expect(results[0]).toMatchObject({ contactPhoneId: 'a', phone: '+12125550001', callable: true, reasons: [] })
  })
})

describe('runCallableNow — response shape + event', () => {
  it('every result carries BOTH contactPhoneId and phone (even fail-closed)', async () => {
    const { deps } = makeDeps({
      loadContactPhones: loaded({ a: NY(), b: NY({ phone: '+12125550002', timezone: null }) }),
    })
    const { results } = await runCallableNow({ contactPhoneIds: ['a', 'b', 'missing'] }, deps)
    expect(results).toHaveLength(3)
    for (const r of results) {
      expect(r).toHaveProperty('contactPhoneId')
      expect(r).toHaveProperty('phone')
      expect(typeof r.phone).toBe('string')
    }
    expect(results[2]).toMatchObject({ contactPhoneId: 'missing', phone: '' })
  })

  it('persists one ScrubLog per result and emits scrub.completed with correct counts', async () => {
    const { deps, persistCalls } = makeDeps({
      loadContactPhones: loaded({ a: NY(), b: NY({ phone: '+12125550002', timezone: null }) }),
    })
    const { results } = await runCallableNow({ contactPhoneIds: ['a', 'b'] }, deps)
    expect(persistCalls).toHaveLength(1)
    expect(persistCalls[0].logs).toHaveLength(2)
    expect(persistCalls[0].event).toMatchObject({ phoneCount: 2, blockedCount: 1, correlationId: CID })
    expect(persistCalls[0].event.checkedAt).toBe(MON_NOON_EST.toISOString())
    expect(results.filter((r) => !r.callable)).toHaveLength(1)
  })

  it('respects atInstant over deps.now', async () => {
    const { deps } = makeDeps({ loadContactPhones: loaded({ a: NY() }) })
    // Saturday even though deps.now is a weekday -> day-blocked.
    const { results } = await runCallableNow(
      { contactPhoneIds: ['a'], atInstant: '2026-01-03T17:00:00Z' },
      deps
    )
    expect(results[0].reasons).toEqual(['outside_calling_window_day'])
  })

  it('falls back to deps.now on an unparseable atInstant', async () => {
    const { deps } = makeDeps({ loadContactPhones: loaded({ a: NY() }) })
    const { results } = await runCallableNow({ contactPhoneIds: ['a'], atInstant: 'not-a-date' }, deps)
    expect(results[0].callable).toBe(true) // deps.now is Monday noon -> callable
  })

  it('throws BatchTooLargeError above the 100 cap', async () => {
    const { deps } = makeDeps()
    const ids = Array.from({ length: CALLABLE_NOW_MAX + 1 }, (_, i) => `id_${i}`)
    await expect(runCallableNow({ contactPhoneIds: ids }, deps)).rejects.toThrow(BatchTooLargeError)
  })
})
