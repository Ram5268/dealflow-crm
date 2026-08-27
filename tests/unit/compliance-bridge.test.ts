import { describe, it, expect, afterEach } from 'vitest'
import {
  checkCallable,
  resolveBatchSize,
  HARD_BATCH_CAP,
  FAIL_CLOSED_REASON,
  type BatchCaller,
  type CallableEntry,
} from '@/lib/core-data/query-dsl/compliance-bridge'
import { REASON_CODES } from '@/lib/shared/reason-codes'

const isKnown = (r: string) => (REASON_CODES as readonly string[]).includes(r)

const entry = (id: string, phone = `+1212555${id}`, timezone?: string): CallableEntry => ({
  contactPhoneId: id,
  phone,
  ...(timezone ? { timezone } : {}),
})

describe('compliance-bridge — checkCallable', () => {
  it('empty entries → empty outcome, no connectivity failure', async () => {
    const out = await checkCallable([])
    expect(out.byPhoneId.size).toBe(0)
    expect(out.connectivityFailure).toBe(false)
  })

  it('maps callable verdicts by phone id', async () => {
    const caller: BatchCaller = async (body) =>
      body.contactPhoneIds.map((id) => ({ contactPhoneId: id, phone: 'x', callable: id !== '2', reasons: id === '2' ? ['internal_dnc'] : [] }))
    const out = await checkCallable([entry('1'), entry('2')], { caller })
    expect(out.byPhoneId.get('1')?.callable).toBe(true)
    expect(out.byPhoneId.get('2')?.callable).toBe(false)
    expect(out.connectivityFailure).toBe(false)
  })

  it('batch throw → whole batch fail-closed + connectivityFailure', async () => {
    const caller: BatchCaller = async () => {
      throw new Error('ETIMEDOUT')
    }
    const out = await checkCallable([entry('1'), entry('2')], { caller })
    expect(out.byPhoneId.get('1')?.callable).toBe(false)
    expect(out.byPhoneId.get('2')?.callable).toBe(false)
    expect(out.connectivityFailure).toBe(true)
  })

  it('missing entry for a submitted id → fail-closed, no connectivity flag', async () => {
    const caller: BatchCaller = async (body) =>
      body.contactPhoneIds.filter((id) => id !== '2').map((id) => ({ contactPhoneId: id, phone: 'x', callable: true, reasons: [] }))
    const out = await checkCallable([entry('1'), entry('2')], { caller })
    expect(out.byPhoneId.get('1')?.callable).toBe(true)
    expect(out.byPhoneId.get('2')?.callable).toBe(false)
    expect(out.connectivityFailure).toBe(false)
  })

  it('unknown REASON_CODE → callable false, no connectivity flag', async () => {
    const caller: BatchCaller = async (body) =>
      body.contactPhoneIds.map((id) => ({ contactPhoneId: id, phone: 'x', callable: true, reasons: ['made_up_reason'] }))
    const out = await checkCallable([entry('1')], { caller })
    expect(out.byPhoneId.get('1')?.callable).toBe(false)
    expect(out.connectivityFailure).toBe(false)
  })

  it('splits into batches of batchSize', async () => {
    const batches: number[] = []
    const caller: BatchCaller = async (body) => {
      batches.push(body.contactPhoneIds.length)
      return body.contactPhoneIds.map((id) => ({ contactPhoneId: id, phone: 'x', callable: true, reasons: [] }))
    }
    const entries = Array.from({ length: 5 }, (_, i) => entry(String(i)))
    await checkCallable(entries, { caller, batchSize: 2 })
    expect(batches).toEqual([2, 2, 1])
  })
})

// Drift guard (integration-runbook M2 / review-2): every reason A itself emits on
// a fail-closed path MUST be a member of the shared REASON_CODES enum. Without this
// the failure is silent — `reasons` was `string[]`, so a stale literal compiled fine
// and only ever fired on the compliance-outage path, which contract tests (healthy
// mock C) never exercise. When C's PR#2 rewrite drops `vendor_error`, the ReasonCode
// typing breaks the build AND this test goes red — loud on both axes.
describe('compliance-bridge — fail-closed reasons are always valid REASON_CODES', () => {
  it('FAIL_CLOSED_REASON is a member of the frozen enum', () => {
    expect(isKnown(FAIL_CLOSED_REASON)).toBe(true)
  })

  it('batch-failure fail-closed emits only known reason codes (non-empty)', async () => {
    const caller: BatchCaller = async () => {
      throw new Error('ETIMEDOUT')
    }
    const out = await checkCallable([entry('1'), entry('2')], { caller })
    for (const v of out.byPhoneId.values()) {
      expect(v.callable).toBe(false)
      expect(v.reasons.length).toBeGreaterThan(0)
      expect(v.reasons.every(isKnown)).toBe(true)
    }
  })

  it('omitted-id fail-closed emits only known reason codes', async () => {
    const caller: BatchCaller = async (body) =>
      body.contactPhoneIds
        .filter((id) => id !== '2')
        .map((id) => ({ contactPhoneId: id, phone: 'x', callable: true, reasons: [] }))
    const out = await checkCallable([entry('1'), entry('2')], { caller })
    const v = out.byPhoneId.get('2')!
    expect(v.callable).toBe(false)
    expect(v.reasons.length).toBeGreaterThan(0)
    expect(v.reasons.every(isKnown)).toBe(true)
  })

  it('unknown-code drift → verdict carries only known codes, raw dropped to telemetry', async () => {
    const caller: BatchCaller = async (body) =>
      body.contactPhoneIds.map((id) => ({
        contactPhoneId: id,
        phone: 'x',
        callable: true,
        reasons: ['made_up_reason', 'internal_dnc'],
      }))
    const out = await checkCallable([entry('1')], { caller })
    const v = out.byPhoneId.get('1')!
    expect(v.callable).toBe(false)
    expect(v.reasons.length).toBeGreaterThan(0)
    expect(v.reasons.every(isKnown)).toBe(true)
    // The known code C sent is preserved; the made-up one is not in the verdict.
    expect(v.reasons).toContain('internal_dnc')
    expect(v.reasons).not.toContain('made_up_reason')
  })
})

describe('compliance-bridge — resolveBatchSize', () => {
  const prev = process.env.COMPLIANCE_CALLABLE_BATCH_SIZE
  afterEach(() => {
    if (prev === undefined) delete process.env.COMPLIANCE_CALLABLE_BATCH_SIZE
    else process.env.COMPLIANCE_CALLABLE_BATCH_SIZE = prev
  })

  it('defaults to the hard cap', () => {
    delete process.env.COMPLIANCE_CALLABLE_BATCH_SIZE
    expect(resolveBatchSize()).toBe(HARD_BATCH_CAP)
  })

  it('honors a value at or below the cap', () => {
    process.env.COMPLIANCE_CALLABLE_BATCH_SIZE = '50'
    expect(resolveBatchSize()).toBe(50)
  })

  it('throws loudly above the cap', () => {
    process.env.COMPLIANCE_CALLABLE_BATCH_SIZE = '250'
    expect(() => resolveBatchSize()).toThrow(/exceeds the locked contract cap/)
  })
})
