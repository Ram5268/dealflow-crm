import { describe, it, expect } from 'vitest'
import {
  pickPrimaryContact,
  pickPrimaryPhone,
  displayTimezone,
  complianceTimezone,
  DISPLAY_TZ_FALLBACK,
  type PhoneLike,
} from '@/lib/core-data/smart-view/queue-service'

const d = (s: string) => new Date(s)

describe('primacy — contact', () => {
  it('lowest createdAt wins', () => {
    const c = pickPrimaryContact([
      { id: 'b', createdAt: d('2026-02-01') },
      { id: 'a', createdAt: d('2026-01-01') },
    ])
    expect(c?.id).toBe('a')
  })
  it('ties broken by id ascending', () => {
    const c = pickPrimaryContact([
      { id: 'z', createdAt: d('2026-01-01') },
      { id: 'a', createdAt: d('2026-01-01') },
    ])
    expect(c?.id).toBe('a')
  })
  it('empty → null', () => {
    expect(pickPrimaryContact([])).toBeNull()
  })
})

describe('primacy — phone', () => {
  const phone = (id: string, isPrimary: boolean, createdAt: string): PhoneLike => ({
    id,
    phone: `+1${id}`,
    isPrimary,
    createdAt: d(createdAt),
  })

  it('isPrimary flag wins over createdAt', () => {
    const p = pickPrimaryPhone([
      phone('early', false, '2026-01-01'),
      phone('flagged', true, '2026-03-01'),
    ])
    expect(p?.id).toBe('flagged')
  })
  it('no flag → lowest createdAt, ties by id', () => {
    const p = pickPrimaryPhone([
      phone('z', false, '2026-01-01'),
      phone('a', false, '2026-01-01'),
    ])
    expect(p?.id).toBe('a')
  })
  it('empty → null', () => {
    expect(pickPrimaryPhone([])).toBeNull()
  })
})

describe('timezone split semantics', () => {
  it('display: contact ?? lead ?? America/New_York', () => {
    expect(displayTimezone('America/Chicago', 'America/Denver')).toBe('America/Chicago')
    expect(displayTimezone(null, 'America/Denver')).toBe('America/Denver')
    expect(displayTimezone(null, null)).toBe(DISPLAY_TZ_FALLBACK)
  })
  it('compliance: contact ?? lead, NEVER fabricated', () => {
    expect(complianceTimezone('America/Chicago', 'America/Denver')).toBe('America/Chicago')
    expect(complianceTimezone(null, 'America/Denver')).toBe('America/Denver')
    expect(complianceTimezone(null, null)).toBeUndefined()
  })
})
