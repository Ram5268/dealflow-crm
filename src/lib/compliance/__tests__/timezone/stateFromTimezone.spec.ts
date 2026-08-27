import { describe, it, expect } from 'vitest'
import { stateFromTimezone } from '@/lib/compliance/timezone/stateFromTimezone'
import { normalizeState, statesForTimezone } from '@/lib/compliance/timezone/tzStateMap'

describe('stateFromTimezone', () => {
  it('prefers the (normalized) address state over the timezone', () => {
    expect(stateFromTimezone({ addressState: 'ny', timezone: 'America/Chicago' })).toBe('NY')
    expect(stateFromTimezone({ addressState: ' Ca ', timezone: 'America/New_York' })).toBe('CA')
  })

  it('falls back to a single-state timezone bucket when no address state', () => {
    expect(stateFromTimezone({ addressState: null, timezone: 'America/Phoenix' })).toBe('AZ')
    expect(stateFromTimezone({ timezone: 'Pacific/Honolulu' })).toBe('HI')
    expect(stateFromTimezone({ timezone: 'America/Anchorage' })).toBe('AK')
  })

  it('returns null for a multi-state timezone with no address state (fail-closed over-block handled downstream)', () => {
    expect(stateFromTimezone({ addressState: null, timezone: 'America/New_York' })).toBeNull()
    expect(stateFromTimezone({ addressState: '', timezone: 'America/Chicago' })).toBeNull()
  })

  it('ignores an invalid address state and falls through to the tz bucket', () => {
    expect(stateFromTimezone({ addressState: 'ZZ', timezone: 'America/Phoenix' })).toBe('AZ')
    expect(stateFromTimezone({ addressState: 'ZZ', timezone: 'America/New_York' })).toBeNull()
  })

  it('returns null for an unknown timezone with no address', () => {
    expect(stateFromTimezone({ timezone: 'Etc/Weird' })).toBeNull()
  })
})

describe('tzStateMap helpers', () => {
  it('normalizeState validates + upper-cases', () => {
    expect(normalizeState('ny')).toBe('NY')
    expect(normalizeState(' pr ')).toBe('PR')
    expect(normalizeState('ZZ')).toBeNull()
    expect(normalizeState(null)).toBeNull()
    expect(normalizeState('')).toBeNull()
  })

  it('statesForTimezone is broad for Eastern and empty for unknown', () => {
    expect(statesForTimezone('America/New_York')).toContain('NY')
    expect(statesForTimezone('America/New_York').length).toBeGreaterThan(1)
    expect(statesForTimezone('Etc/Weird')).toEqual([])
  })
})
