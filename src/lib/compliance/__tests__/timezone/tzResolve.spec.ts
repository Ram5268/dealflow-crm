import { describe, it, expect } from 'vitest'
import { resolveTimezone, tzResolveByContactId } from '@/lib/compliance/timezone/tzResolve'
import { TimezoneUnresolvedError } from '@/lib/compliance/errors'

describe('resolveTimezone (presence-only, NO fallback)', () => {
  it('returns the timezone when present', () => {
    expect(resolveTimezone('America/New_York')).toBe('America/New_York')
  })

  it('trims surrounding whitespace', () => {
    expect(resolveTimezone('  America/Chicago  ')).toBe('America/Chicago')
  })

  it('throws TimezoneUnresolvedError on null / undefined / empty / whitespace', () => {
    expect(() => resolveTimezone(null)).toThrow(TimezoneUnresolvedError)
    expect(() => resolveTimezone(undefined)).toThrow(TimezoneUnresolvedError)
    expect(() => resolveTimezone('')).toThrow(TimezoneUnresolvedError)
    expect(() => resolveTimezone('   ')).toThrow(TimezoneUnresolvedError)
  })

  it('never substitutes a default zone', () => {
    // An invalid-but-present string passes through here (windowCheck rejects it
    // as timezone_invalid); the point is we NEVER return NYC_TIMEZONE_DEFAULT.
    expect(resolveTimezone('Etc/Weird')).toBe('Etc/Weird')
  })
})

describe('tzResolveByContactId', () => {
  const db = (timezone: string | null | undefined, exists = true) => ({
    contact: {
      findUnique: async () => (exists ? { timezone: timezone ?? null } : null),
    },
  })

  it('resolves a present timezone', async () => {
    await expect(tzResolveByContactId('c1', db('America/Denver'))).resolves.toBe('America/Denver')
  })

  it('throws when the contact row is missing', async () => {
    await expect(tzResolveByContactId('c1', db(null, false))).rejects.toThrow(TimezoneUnresolvedError)
  })

  it('throws when the contact timezone is null', async () => {
    await expect(tzResolveByContactId('c1', db(null))).rejects.toThrow(TimezoneUnresolvedError)
  })
})
