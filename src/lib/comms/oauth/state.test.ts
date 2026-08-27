import { describe, it, expect } from 'vitest'
import { signState, verifyState } from './state'

const SECRET = 'test-oauth-state-secret'
const t0 = 1_756_000_000_000 // fixed clock

describe('signState / verifyState', () => {
  it('round-trips orgId + provider', () => {
    const s = signState({ orgId: 'org_1', provider: 'gmail' }, { secret: SECRET, now: t0 })
    expect(verifyState(s, { secret: SECRET, now: t0 })).toEqual({
      orgId: 'org_1',
      provider: 'gmail',
    })
  })

  it('is unique per call (nonce)', () => {
    const a = signState({ orgId: 'org_1', provider: 'gmail' }, { secret: SECRET, now: t0 })
    const b = signState({ orgId: 'org_1', provider: 'gmail' }, { secret: SECRET, now: t0 })
    expect(a).not.toBe(b)
  })

  it('rejects a tampered body', () => {
    const s = signState({ orgId: 'org_1', provider: 'gmail' }, { secret: SECRET, now: t0 })
    const [, mac] = s.split('.')
    const forged = Buffer.from(JSON.stringify({ orgId: 'attacker', provider: 'gmail', nonce: 'x', ts: t0 })).toString('base64url')
    expect(() => verifyState(`${forged}.${mac}`, { secret: SECRET, now: t0 })).toThrow(/signature mismatch/)
  })

  it('rejects a wrong secret', () => {
    const s = signState({ orgId: 'org_1', provider: 'gmail' }, { secret: SECRET, now: t0 })
    expect(() => verifyState(s, { secret: 'other', now: t0 })).toThrow(/signature mismatch/)
  })

  it('rejects an expired state (older than maxAge)', () => {
    const s = signState({ orgId: 'org_1', provider: 'gmail' }, { secret: SECRET, now: t0 })
    expect(() =>
      verifyState(s, { secret: SECRET, now: t0 + 11 * 60 * 1000 }),
    ).toThrow(/expired/)
  })

  it('accepts within the max-age window', () => {
    const s = signState({ orgId: 'org_1', provider: 'gmail' }, { secret: SECRET, now: t0 })
    expect(verifyState(s, { secret: SECRET, now: t0 + 9 * 60 * 1000 }).orgId).toBe('org_1')
  })

  it('rejects a future timestamp beyond clock skew', () => {
    const s = signState({ orgId: 'org_1', provider: 'gmail' }, { secret: SECRET, now: t0 + 5 * 60 * 1000 })
    expect(() => verifyState(s, { secret: SECRET, now: t0 })).toThrow(/future/)
  })

  it('rejects malformed input', () => {
    expect(() => verifyState('nodot', { secret: SECRET })).toThrow(/invalid state format/)
  })

  it('throws when no secret is configured', () => {
    const prev = process.env.OAUTH_STATE_SECRET
    delete process.env.OAUTH_STATE_SECRET
    try {
      expect(() => signState({ orgId: 'o', provider: 'gmail' })).toThrow(/not set/)
    } finally {
      if (prev !== undefined) process.env.OAUTH_STATE_SECRET = prev
    }
  })
})
