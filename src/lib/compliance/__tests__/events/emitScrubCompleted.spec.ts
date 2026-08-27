import { describe, it, expect } from 'vitest'
import { emitScrubCompleted } from '@/lib/compliance/events/emitScrubCompleted'
import { ScrubCompletedEvent } from '../../../../../contracts/events/scrub.completed'

const CID = '11111111-1111-4111-8111-111111111111'

describe('emitScrubCompleted', () => {
  it('emits a Zod-valid, discriminant-free payload via pg_notify on crm_scrub', async () => {
    let query = ''
    let value: unknown
    const tx = {
      $executeRaw: async (parts: TemplateStringsArray, ...vals: unknown[]) => {
        query = parts.join('?')
        value = vals[0]
        return 1
      },
    }
    await emitScrubCompleted(
      { phoneCount: 10, blockedCount: 3, checkedAt: '2026-09-01T00:00:00.000Z', correlationId: CID },
      tx
    )
    expect(query).toContain("pg_notify('crm_scrub'")
    const parsed = JSON.parse(value as string)
    // Round-trips through the frozen contract schema, camelCase, no discriminant.
    expect(() => ScrubCompletedEvent.parse(parsed)).not.toThrow()
    expect('type' in parsed).toBe(false)
    expect('eventName' in parsed).toBe(false)
    expect(parsed).toEqual({ phoneCount: 10, blockedCount: 3, checkedAt: '2026-09-01T00:00:00.000Z', correlationId: CID })
  })

  it('rejects a malformed payload before touching the wire', async () => {
    let called = false
    const tx = { $executeRaw: async () => ((called = true), 1) }
    await expect(
      emitScrubCompleted({ phoneCount: 'x' as any, blockedCount: 0, checkedAt: '', correlationId: CID }, tx)
    ).rejects.toBeTruthy()
    expect(called).toBe(false)
  })
})
