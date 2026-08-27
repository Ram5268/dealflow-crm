import { describe, it, expect, vi } from 'vitest'
import { dispatch, type DemuxHandlers } from '../../src/lib/core-data/events/demux'
import { CallConnectedEvent } from '../events/call.connected'
import { CallCompletedEvent } from '../events/call.completed'
import { MessageReceivedEvent } from '../events/message.received'
import { ScrubCompletedEvent } from '../events/scrub.completed'
import { PacingUpdateEvent } from '../events/dial-session.pacing-update'

// Gate 2 (A → mocks it CONSUMES): payloads matching the frozen consumer schemas
// route to the right handler; a pacing-update variant proves no-crash + no-write;
// unknown shapes are ignored. Uses fake handlers so routing is asserted without
// any DB side effects.

function fakeHandlers() {
  const calls: string[] = []
  const mk = (n: string) => vi.fn(async () => { calls.push(n) })
  const handlers: DemuxHandlers = {
    'call.connected': mk('call.connected'),
    'call.completed': mk('call.completed'),
    'dial-session.pacing-update': mk('dial-session.pacing-update'),
    'message.received': mk('message.received'),
    'scrub.completed': mk('scrub.completed'),
  }
  return { handlers, calls }
}

const CID = '33333333-3333-4333-8333-333333333333'

describe('accepts-events — schema-valid payloads route correctly', () => {
  it('call.connected', async () => {
    const p = CallConnectedEvent.parse({
      type: 'call.connected', callId: 'c1', dialSessionId: 'd1', leadId: 'l1', contactId: 'ct1',
      remotePhone: '+12125551234', connectedAt: '2026-08-27T12:00:00Z', correlationId: CID,
    })
    const { handlers, calls } = fakeHandlers()
    expect(await dispatch('crm_call', p, handlers)).toBe('handled')
    expect(calls).toEqual(['call.connected'])
  })

  it('call.completed with cost as decimal-string', async () => {
    const p = CallCompletedEvent.parse({
      type: 'call.completed', callId: 'c1', disposition: 'answered', duration: 63, cost: '12.3400', correlationId: CID,
    })
    expect(typeof p.cost).toBe('string')
    const { handlers, calls } = fakeHandlers()
    await dispatch('crm_call', p, handlers)
    expect(calls).toEqual(['call.completed'])
  })

  it('message.received', async () => {
    const p = MessageReceivedEvent.parse({ messageId: 'm1', channel: 'email', leadId: 'l1', correlationId: CID })
    const { handlers, calls } = fakeHandlers()
    await dispatch('crm_message', p, handlers)
    expect(calls).toEqual(['message.received'])
  })

  it('scrub.completed', async () => {
    const p = ScrubCompletedEvent.parse({ phoneCount: 5, blockedCount: 2, checkedAt: '2026-08-27T12:00:00Z', correlationId: CID })
    const { handlers, calls } = fakeHandlers()
    await dispatch('crm_scrub', p, handlers)
    expect(calls).toEqual(['scrub.completed'])
  })
})

describe('accepts-events — pacing-update no-crash + no-write', () => {
  it('routes to the no-op handler, never crashes', async () => {
    const p = PacingUpdateEvent.parse({
      type: 'dial-session.pacing-update', sessionId: 'd1', lineCount: 3, rollingAbandonment: 0.02, band: '1_5_to_2_0', reason: 'test-band-transition', correlationId: CID,
    })
    const { handlers, calls } = fakeHandlers()
    expect(await dispatch('crm_call', p, handlers)).toBe('handled')
    expect(calls).toEqual(['dial-session.pacing-update'])
  })

  it('a genuinely unknown crm_call shape is ignored (listener must not crash)', async () => {
    const { handlers, calls } = fakeHandlers()
    expect(await dispatch('crm_call', { foo: 'bar', correlationId: CID }, handlers)).toBe('ignored')
    expect(calls).toEqual([])
  })
})
