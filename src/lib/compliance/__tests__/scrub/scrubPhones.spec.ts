import { describe, it, expect } from 'vitest'
import { scrubPhones, type ScrubPhonesDeps } from '@/lib/compliance/scrub/scrubPhones'
import type { DncStatus } from '@/lib/compliance/dnc/check'
import type { LitigatorStatus } from '@/lib/compliance/litigator/check'

function deps(over: Partial<ScrubPhonesDeps> = {}) {
  const persisted: Array<{ logs: any[]; event: any }> = []
  const d: ScrubPhonesDeps = {
    orgId: 'o',
    correlationId: '11111111-1111-4111-8111-111111111111',
    now: new Date('2026-09-01T00:00:00Z'),
    hasAnyConfirmedPolicy: async () => true,
    internalDncHits: async () => new Set<string>(),
    checkDnc: async (_o, ps) => new Map<string, DncStatus>(ps.map((p) => [p, { status: 'clean' }])),
    checkLitigator: async (_o, ps) => new Map<string, LitigatorStatus>(ps.map((p) => [p, { status: 'clean' }])),
    persist: async (_o, logs, event) => void persisted.push({ logs, event }),
    ...over,
  }
  return { d, persisted }
}

describe('scrubPhones', () => {
  it('no confirmed policy anywhere → all policy_unconfirmed, no vendor spend', async () => {
    let dncCalled = false
    const { d } = deps({
      hasAnyConfirmedPolicy: async () => false,
      checkDnc: async (_o, ps) => ((dncCalled = true), new Map(ps.map((p) => [p, { status: 'clean' as const }]))),
    })
    const { results } = await scrubPhones(['+1', '+2'], d)
    expect(results.every((r) => r.reasons[0] === 'policy_unconfirmed' && !r.callable)).toBe(true)
    expect(dncCalled).toBe(false)
  })

  it('internal DNC blocks before vendor checks', async () => {
    const { d } = deps({ internalDncHits: async () => new Set(['+1']) })
    const { results } = await scrubPhones(['+1'], d)
    expect(results[0]).toEqual({ phone: '+1', callable: false, reasons: ['internal_dnc'] })
  })

  it('federal DNC block carries no detail; state DNC carries state', async () => {
    const { d } = deps({
      checkDnc: async () =>
        new Map<string, DncStatus>([
          ['+fed', { status: 'blocked', reason: 'federal_dnc' }],
          ['+st', { status: 'blocked', reason: 'state_dnc', detail: { state: 'NY' } }],
        ]),
    })
    const { results } = await scrubPhones(['+fed', '+st'], d)
    expect(results[0].reasons).toEqual(['federal_dnc'])
    expect(results[1].reasonDetails).toEqual({ state_dnc: { state: 'NY' } })
  })

  it('DNC vendor error → fail-closed', async () => {
    const { d } = deps({ checkDnc: async () => new Map([['+1', { status: 'error', reason: 'vendor_error_dnc' }]]) })
    const { results } = await scrubPhones(['+1'], d)
    expect(results[0]).toMatchObject({ callable: false, reasons: ['vendor_error_dnc'] })
  })

  it('litigator block after DNC clean', async () => {
    const { d } = deps({
      checkLitigator: async () => new Map([['+1', { status: 'blocked', reason: 'litigator', detail: { vendor: 'tcpa_shield' } }]]),
    })
    const { results } = await scrubPhones(['+1'], d)
    expect(results[0].reasons).toEqual(['litigator'])
    expect(results[0].reasonDetails).toEqual({ litigator: { vendor: 'tcpa_shield' } })
  })

  it('all-clean → callable:true and emits scrub.completed with counts', async () => {
    const { d, persisted } = deps()
    const { results, scrubbedAt } = await scrubPhones(['+1', '+2'], d)
    expect(results.every((r) => r.callable)).toBe(true)
    expect(persisted).toHaveLength(1)
    expect(persisted[0].event).toMatchObject({ phoneCount: 2, blockedCount: 0 })
    expect(scrubbedAt).toBe('2026-09-01T00:00:00.000Z')
  })
})
