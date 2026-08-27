import { describe, it, expect } from 'vitest'
import { z } from 'zod'
import { scrubPhones, type ScrubPhonesDeps } from '@/lib/compliance/scrub/scrubPhones'
import type { DncStatus } from '@/lib/compliance/dnc/check'
import type { LitigatorStatus } from '@/lib/compliance/litigator/check'
import { reasonCodeSchema, REASON_CODES } from '../../http/reason-codes'

// Gate 2 — POST /api/compliance/scrub response shape. camelCase; every reason
// drawn from REASON_CODES; per-result carries phone + callable + reasons.
const resultSchema = z
  .object({
    phone: z.string(),
    callable: z.boolean(),
    reasons: z.array(reasonCodeSchema),
    reasonDetails: z.record(z.string(), z.unknown()).optional(),
  })
  .strict()
const responseSchema = z.object({ results: z.array(resultSchema), scrubbedAt: z.string() }).strict()

function deps(over: Partial<ScrubPhonesDeps> = {}): ScrubPhonesDeps {
  return {
    orgId: 'o',
    correlationId: '11111111-1111-4111-8111-111111111111',
    now: new Date('2026-09-01T00:00:00Z'),
    hasAnyConfirmedPolicy: async () => true,
    internalDncHits: async () => new Set<string>(['+internal']),
    checkDnc: async (_o, ps) =>
      new Map<string, DncStatus>(
        ps.map((p) => [p, p === '+fed' ? { status: 'blocked', reason: 'federal_dnc' } : p === '+err' ? { status: 'error', reason: 'vendor_error_dnc' } : { status: 'clean' }])
      ),
    checkLitigator: async (_o, ps) =>
      new Map<string, LitigatorStatus>(ps.map((p) => [p, p === '+lit' ? { status: 'blocked', reason: 'litigator', detail: { vendor: 'tcpa_shield' } } : { status: 'clean' }])),
    persist: async () => {},
    ...over,
  }
}

describe('scrub response contract', () => {
  it('conforms to the locked shape and only emits REASON_CODES', async () => {
    const out = await scrubPhones(['+internal', '+fed', '+err', '+lit', '+ok'], deps())
    expect(() => responseSchema.parse(out)).not.toThrow()
    const reasons = new Set(out.results.flatMap((r) => r.reasons))
    for (const reason of reasons) expect(REASON_CODES).toContain(reason)
    expect(reasons).toContain('internal_dnc')
    expect(reasons).toContain('federal_dnc')
    expect(reasons).toContain('litigator')
  })

  it('policy-unconfirmed org short-circuits all phones (still valid REASON_CODES)', async () => {
    const out = await scrubPhones(['+1', '+2'], deps({ hasAnyConfirmedPolicy: async () => false }))
    expect(() => responseSchema.parse(out)).not.toThrow()
    expect(out.results.every((r) => r.reasons[0] === 'policy_unconfirmed')).toBe(true)
  })
})
