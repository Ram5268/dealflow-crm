import { describe, it, expect } from 'vitest'
import { toE164, canonicalPhones } from '@/lib/shared/phone'

// Brief 41 (H13): one canonical phone form (E.164, US default) for the opt-out
// list and the contacts API, the same as the importer's.
describe('toE164', () => {
  it('gives +1XXXXXXXXXX however a US number is typed', () => {
    for (const typed of ['917-555-0147', '(917) 555-0147', '9175550147', '1-917-555-0147', '917.555.0147', '+1 917 555 0147', ' 19175550147']) {
      expect(toE164(typed)).toBe('+19175550147')
    }
  })
  it('keeps non-US numbers, and accepts unusual but possible ones (an opt-out is never refused for that)', () => {
    expect(toE164('+44 20 7946 0750')).toBe('+442079460750')
    expect(toE164('+1 555 555 0101')).toBe('+15555550101')
  })
  it('null for anything that is not a phone number', () => {
    for (const bad of ['', '   ', 'garbage', '12345', null, undefined]) expect(toE164(bad)).toBeNull()
  })
})

describe('canonicalPhones (contacts API)', () => {
  it('stores every phone in canonical form, keeping the other fields', () => {
    expect(canonicalPhones([{ phone: '(917) 555-0147', type: 'mobile', isPrimary: true }, { phone: '212.555.0101', type: 'home', isPrimary: false }])).toEqual({
      ok: true,
      phones: [{ phone: '+19175550147', type: 'mobile', isPrimary: true }, { phone: '+12125550101', type: 'home', isPrimary: false }],
    })
  })
  it('keeps one number typed twice once (a contact\'s phones are unique)', () => {
    expect(canonicalPhones([{ phone: '917-555-0147', type: 'mobile' }, { phone: '+19175550147', type: 'home' }])).toEqual({
      ok: true,
      phones: [{ phone: '+19175550147', type: 'mobile' }],
    })
  })
  it('names the first value that is not a phone number (→ 400)', () => {
    expect(canonicalPhones([{ phone: '917-555-0147' }, { phone: 'call me' }])).toEqual({ ok: false, invalid: 'call me' })
  })
})
