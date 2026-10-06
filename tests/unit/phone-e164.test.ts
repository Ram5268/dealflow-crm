import { describe, it, expect } from 'vitest'
import { toE164, canonicalPhones } from '@/lib/shared/phone'

// Brief 41 (H13): one canonical phone form (E.164, US default) for the opt-out
// list and the contacts API, the same as the importer's.
describe('toE164', () => {
  it('gives +1XXXXXXXXXX however a US number is typed', () => {
    for (const typed of ['917-331-2047', '(917) 331-2047', '9173312047', '1-917-331-2047', '917.331.2047', '+1 917 331 2047', ' 19173312047']) {
      expect(toE164(typed)).toBe('+19173312047')
    }
  })
  it('keeps non-US numbers, and accepts unusual but possible ones (an opt-out is never refused for that)', () => {
    expect(toE164('+44 20 7183 8750')).toBe('+442071838750')
    expect(toE164('+1 555 555 0101')).toBe('+15555550101')
  })
  it('null for anything that is not a phone number', () => {
    for (const bad of ['', '   ', 'garbage', '12345', null, undefined]) expect(toE164(bad)).toBeNull()
  })
})

describe('canonicalPhones (contacts API)', () => {
  it('stores every phone in canonical form, keeping the other fields', () => {
    expect(canonicalPhones([{ phone: '(917) 331-2047', type: 'mobile', isPrimary: true }, { phone: '212.555.0101', type: 'home', isPrimary: false }])).toEqual({
      ok: true,
      phones: [{ phone: '+19173312047', type: 'mobile', isPrimary: true }, { phone: '+12125550101', type: 'home', isPrimary: false }],
    })
  })
  it('names the first value that is not a phone number (→ 400)', () => {
    expect(canonicalPhones([{ phone: '917-331-2047' }, { phone: 'call me' }])).toEqual({ ok: false, invalid: 'call me' })
  })
})
