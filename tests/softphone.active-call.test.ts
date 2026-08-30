import { describe, it, expect } from 'vitest'
import { nextActiveCallId } from '@/lib/telephony/softphone/activeCall'

/**
 * Regression cover for the DialerShell closure bug (planner §13 micro-amendment).
 *
 * `activeCallId` is what DialerShell feeds to AmmunitionPanel, and the panel
 * clears itself when that prop is null (`if (!activeCallId) { setData(null) }`).
 * So "the reducer returns null" IS "the ammunition panel clears".
 */
describe('nextActiveCallId', () => {
  it('call.connected sets the active call', () => {
    expect(nextActiveCallId(null, { type: 'call.connected', callId: 'call_1' })).toBe('call_1')
  })

  it('REGRESSION: call.completed clears the call that connected', () => {
    // The exact sequence the old closure could not handle: the handler compared
    // against a mount-time null, so this returned 'call_1' forever and the
    // ammunition panel stayed stuck on a finished call.
    const connected = nextActiveCallId(null, { type: 'call.connected', callId: 'call_1' })
    expect(connected).toBe('call_1')
    expect(nextActiveCallId(connected, { type: 'call.completed', callId: 'call_1' })).toBeNull()
  })

  it('ignores completion of a call we are not on', () => {
    expect(nextActiveCallId('call_1', { type: 'call.completed', callId: 'call_2' })).toBe('call_1')
  })

  it('lets a new connect win even if the previous call never completed', () => {
    expect(nextActiveCallId('call_1', { type: 'call.connected', callId: 'call_2' })).toBe('call_2')
  })

  it('ignores frames with no callId', () => {
    expect(nextActiveCallId('call_1', { type: 'call.completed' })).toBe('call_1')
    expect(nextActiveCallId('call_1', {})).toBe('call_1')
  })

  it('ignores unrelated event types on the same channel', () => {
    expect(nextActiveCallId('call_1', { type: 'pacing.update', callId: 'call_9' })).toBe('call_1')
    expect(nextActiveCallId(null, { type: 'pacing.update', callId: 'call_9' })).toBeNull()
  })

  it('is idempotent — a duplicated completion does not resurrect a call', () => {
    const cleared = nextActiveCallId('call_1', { type: 'call.completed', callId: 'call_1' })
    expect(nextActiveCallId(cleared, { type: 'call.completed', callId: 'call_1' })).toBeNull()
  })
})
