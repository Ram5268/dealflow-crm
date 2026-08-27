import { describe, it, expect } from 'vitest'
import { emitScrubCompleted } from '@/lib/compliance/events/emitScrubCompleted'
import { ScrubCompletedEvent } from '../../events/scrub.completed'

const CID = '11111111-1111-4111-8111-111111111111'

// Gate 2 — scrub.completed emission. Validates against the frozen Zod schema,
// asserts channel-as-routing (no eventName/type discriminant), camelCase, and
// that the NOTIFY targets crm_scrub.
describe('scrub.completed event contract', () => {
  it('emits a schema-valid, discriminant-free payload on crm_scrub', async () => {
    let channelQuery = ''
    let json: unknown
    const tx = {
      $executeRaw: async (parts: TemplateStringsArray, ...vals: unknown[]) => {
        channelQuery = parts.join('?')
        json = vals[0]
        return 1
      },
    }
    await emitScrubCompleted(
      { phoneCount: 7, blockedCount: 2, checkedAt: '2026-09-01T00:00:00.000Z', correlationId: CID },
      tx
    )
    expect(channelQuery).toContain("pg_notify('crm_scrub'")
    const payload = JSON.parse(json as string)
    expect(() => ScrubCompletedEvent.parse(payload)).not.toThrow()
    expect('type' in payload).toBe(false)
    expect('eventName' in payload).toBe(false)
    expect(Object.keys(payload).sort()).toEqual(['blockedCount', 'checkedAt', 'correlationId', 'phoneCount'])
  })
})
