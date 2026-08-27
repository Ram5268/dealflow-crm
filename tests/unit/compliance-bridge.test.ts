import { describe, it, expect, afterEach } from 'vitest'
import {
  checkCallable,
  resolveBatchSize,
  HARD_BATCH_CAP,
  type BatchCaller,
  type CallableEntry,
} from '@/lib/core-data/query-dsl/compliance-bridge'

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
