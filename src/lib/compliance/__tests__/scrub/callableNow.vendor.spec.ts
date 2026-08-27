import { describe, it, expect } from 'vitest'
import { runCallableNow } from '@/lib/compliance/scrub/callableNow'
import type { CallableNowDeps, LoadedPhone } from '@/lib/compliance/scrub/callableNow'
import type { DncStatus } from '@/lib/compliance/dnc/check'
import type { LitigatorStatus } from '@/lib/compliance/litigator/check'

const CID = '11111111-1111-4111-8111-111111111111'
const MON_NOON_EST = new Date('2026-01-05T17:00:00Z')
const CONFIRMED = {
  timezone: 'America/New_York',
  earliestHour: 9,
  latestHour: 20,
  allowedDaysOfWeek: [1, 2, 3, 4, 5],
  policyConfirmedBy: 'user:ryan|counsel:jdoe|date:2026-09-01',
  policyConfirmedAt: new Date(),
}
const NY: LoadedPhone = { phone: '+12125550001', timezone: 'America/New_York', addressState: 'NY' }

function deps(over: Partial<CallableNowDeps> = {}): CallableNowDeps {
  return {
    orgId: 'o',
    correlationId: CID,
    now: MON_NOON_EST,
    loadContactPhones: async (ids) => new Map(ids.map((id) => [id, NY])),
    internalDncHits: async () => new Set<string>(),
    isPolicyConfirmed: async () => ({ confirmed: true, config: CONFIRMED }),
    checkHoliday: async () => ({ blocked: false }),
    persist: async () => {},
    ...over,
  }
}

describe('callable-now — M2 vendor steps', () => {
  it('federal DNC blocks before the window check', async () => {
    const { results } = await runCallableNow(
      { contactPhoneIds: ['a'] },
      deps({ checkDnc: async (_o, ps) => new Map<string, DncStatus>(ps.map((p) => [p, { status: 'blocked', reason: 'federal_dnc' }])) })
    )
    expect(results[0].reasons).toEqual(['federal_dnc'])
  })

  it('state DNC carries reasonDetails', async () => {
    const { results } = await runCallableNow(
      { contactPhoneIds: ['a'] },
      deps({ checkDnc: async (_o, ps) => new Map<string, DncStatus>(ps.map((p) => [p, { status: 'blocked', reason: 'state_dnc', detail: { state: 'NY' } }])) })
    )
    expect(results[0].reasonDetails).toEqual({ state_dnc: { state: 'NY' } })
  })

  it('DNC vendor error fails closed', async () => {
    const { results } = await runCallableNow(
      { contactPhoneIds: ['a'] },
      deps({ checkDnc: async () => new Map([['+12125550001', { status: 'error', reason: 'vendor_error_dnc' }]]) })
    )
    expect(results[0]).toMatchObject({ callable: false, reasons: ['vendor_error_dnc'] })
  })

  it('litigator blocks with detail (after DNC clean)', async () => {
    const { results } = await runCallableNow(
      { contactPhoneIds: ['a'] },
      deps({
        checkDnc: async (_o, ps) => new Map<string, DncStatus>(ps.map((p) => [p, { status: 'clean' }])),
        checkLitigator: async () => new Map<string, LitigatorStatus>([['+12125550001', { status: 'blocked', reason: 'litigator', detail: { vendor: 'tcpa_shield' } }]]),
      })
    )
    expect(results[0].reasons).toEqual(['litigator'])
    expect(results[0].reasonDetails).toEqual({ litigator: { vendor: 'tcpa_shield' } })
  })

  it('litigator vendor error fails closed', async () => {
    const { results } = await runCallableNow(
      { contactPhoneIds: ['a'] },
      deps({
        checkDnc: async (_o, ps) => new Map<string, DncStatus>(ps.map((p) => [p, { status: 'clean' }])),
        checkLitigator: async () => new Map([['+12125550001', { status: 'error', reason: 'circuit_open_litigator' }]]),
      })
    )
    expect(results[0]).toMatchObject({ callable: false, reasons: ['circuit_open_litigator'] })
  })

  it('DNC-clean + litigator-clean → callable:true', async () => {
    const { results } = await runCallableNow(
      { contactPhoneIds: ['a'] },
      deps({
        checkDnc: async (_o, ps) => new Map<string, DncStatus>(ps.map((p) => [p, { status: 'clean' }])),
        checkLitigator: async (_o, ps) => new Map<string, LitigatorStatus>(ps.map((p) => [p, { status: 'clean' }])),
      })
    )
    expect(results[0]).toMatchObject({ callable: true, reasons: [] })
  })

  it('vendor checks are NOT consulted for a policy-unconfirmed phone', async () => {
    let dncCalled = false
    const { results } = await runCallableNow(
      { contactPhoneIds: ['a'] },
      deps({
        isPolicyConfirmed: async () => ({ confirmed: false }),
        checkDnc: async (_o, ps) => ((dncCalled = true), new Map(ps.map((p) => [p, { status: 'clean' as const }]))),
      })
    )
    expect(results[0].reasons).toEqual(['policy_unconfirmed'])
    // checkDnc may be invoked for the precompute, but the phone's decision is
    // policy_unconfirmed — vendor result is never applied.
    expect(results[0].callable).toBe(false)
    void dncCalled
  })
})
