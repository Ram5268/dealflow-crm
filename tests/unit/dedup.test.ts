import { describe, it, expect } from 'vitest'
import { normalizePhoneE164, normalizePhoneType, dedupKey } from '@/lib/core-data/importer/dedup'

describe('normalizePhoneE164', () => {
  it('normalizes US formats to E.164', () => {
    expect(normalizePhoneE164('(212) 555-0134')).toBe('+12125550134')
    expect(normalizePhoneE164('212-555-0134')).toBe('+12125550134')
    expect(normalizePhoneE164('+1 212 555 0134')).toBe('+12125550134')
  })
  it('returns null for junk / empty', () => {
    expect(normalizePhoneE164('not a phone')).toBeNull()
    expect(normalizePhoneE164('')).toBeNull()
    expect(normalizePhoneE164(null)).toBeNull()
    expect(normalizePhoneE164('123')).toBeNull()
  })
})

describe('normalizePhoneType', () => {
  it('maps synonyms to canonical set', () => {
    expect(normalizePhoneType('Cell')).toEqual({ type: 'mobile', nonstandard: false })
    expect(normalizePhoneType('cellular')).toEqual({ type: 'mobile', nonstandard: false })
    expect(normalizePhoneType('Work')).toEqual({ type: 'office', nonstandard: false })
    expect(normalizePhoneType('office phone')).toEqual({ type: 'office', nonstandard: false })
    expect(normalizePhoneType('Residential')).toEqual({ type: 'home', nonstandard: false })
    expect(normalizePhoneType('DD')).toEqual({ type: 'direct', nonstandard: false })
  })
  it('flags unknown values as nonstandard, lowercased', () => {
    expect(normalizePhoneType('Fax')).toEqual({ type: 'fax', nonstandard: true })
  })
  it('empty → default mobile, not flagged', () => {
    expect(normalizePhoneType('')).toEqual({ type: 'mobile', nonstandard: false })
    expect(normalizePhoneType(null)).toEqual({ type: 'mobile', nonstandard: false })
  })
})

describe('dedupKey', () => {
  it('prefers phone', () => {
    expect(dedupKey({ phoneE164: '+12125550134', name: 'X', addressFull: 'Y' })).toEqual({
      kind: 'phone',
      key: 'phone:+12125550134',
    })
  })
  it('falls back to name + address', () => {
    expect(dedupKey({ name: 'Acme LLC', addressFull: '5 Main St' })).toEqual({
      kind: 'name-address',
      key: 'na:acme llc|5 main st',
    })
  })
  it('none when nothing to key on', () => {
    expect(dedupKey({})).toEqual({ kind: 'none', key: null })
  })
})
