import { describe, it, expect, vi } from 'vitest'
import { matchShape, dispatch, type DemuxHandlers } from '@/lib/core-data/events/demux'

function fakeHandlers() {
  const calls: string[] = []
  const make = (name: string) => vi.fn(async () => { calls.push(name) })
  const handlers: DemuxHandlers = {
    'call.connected': make('call.connected'),
    'call.completed': make('call.completed'),
    'dial-session.pacing-update': make('dial-session.pacing-update'),
    'message.received': make('message.received'),
    'scrub.completed': make('scrub.completed'),
  }
  return { handlers, calls }
}

describe('matchShape', () => {
  it('crm_call: connected vs completed vs pacing by shape', () => {
    expect(matchShape('crm_call', { callId: 'c1', connectedAt: 'x', type: 'call.connected' })).toBe('call.connected')
    expect(matchShape('crm_call', { callId: 'c1', disposition: 'answered', type: 'call.completed' })).toBe('call.completed')
    expect(matchShape('crm_call', { type: 'dial-session.pacing-update', sessionId: 'd1', lineCount: 3, rollingAbandonment: 0.02, band: '1_5_to_2_0', reason: 'test-band-transition', correlationId: 'corr-1' })).toBe('dial-session.pacing-update')
  })
  it('crm_message / crm_scrub', () => {
    expect(matchShape('crm_message', { messageId: 'm1', channel: 'email' })).toBe('message.received')
    expect(matchShape('crm_scrub', { phoneCount: 5, blockedCount: 2 })).toBe('scrub.completed')
  })
  it('unknown shape → null', () => {
    expect(matchShape('crm_call', { foo: 'bar' })).toBeNull()
    expect(matchShape('crm_lead_sync', { count: 1 })).toBeNull()
  })
})

describe('dispatch', () => {
  it('routes to the matched handler', async () => {
    const { handlers, calls } = fakeHandlers()
    const r = await dispatch('crm_call', { callId: 'c1', connectedAt: 'x' }, handlers)
    expect(r).toBe('handled')
    expect(calls).toEqual(['call.connected'])
  })

  it('pacing-update routes to its no-op handler (no crash)', async () => {
    const { handlers, calls } = fakeHandlers()
    const r = await dispatch('crm_call', { type: 'dial-session.pacing-update', sessionId: 'd1', lineCount: 2, rollingAbandonment: 0.02, band: '1_5_to_2_0', reason: 'test-band-transition', correlationId: 'corr-2' }, handlers)
    expect(r).toBe('handled')
    expect(calls).toEqual(['dial-session.pacing-update'])
  })

  it('unknown shape → ignored, no handler fired, never throws', async () => {
    const { handlers, calls } = fakeHandlers()
    const r = await dispatch('crm_call', { totally: 'unexpected', correlationId: 'z' }, handlers)
    expect(r).toBe('ignored')
    expect(calls).toEqual([])
  })
})
