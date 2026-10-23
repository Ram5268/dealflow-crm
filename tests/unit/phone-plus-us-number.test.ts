import { describe, it, expect } from 'vitest'
import { toE164 } from '@/lib/shared/phone'

// Brief 50 PR 13 (open item 6.9): people type a "+" before a US number's ten
// digits ("+917 555 0123"). The parser read the "+" as a country code ("+91…"
// is India), so the number wasn't stored as +1 and the 10 digits, and an
// opt-out or a duplicate check could miss it. Now a "+" followed by exactly 10
// digits that form a valid US/NANP number is read as US [engineering
// precaution: the CRM's leads are New York homeowners]. Every phone here is in
// the fictional 555-0100…0199 range, or a published fictional foreign range.
describe('a "+" before a US number\'s 10 digits is read as US: +1 and the 10 digits', () => {
  it('"+917…" is New York, not India, however it is punctuated', () => {
    for (const typed of ['+9175550123', '+917 555 0123', '+917-555-0123', '+917.555.0123', '+(917) 555-0123', '(+917) 555 0123', '+ 917 555 0123']) {
      expect(toE164(typed), typed).toBe('+19175550123')
    }
  })

  it('New York-area codes that used to be refused, or read as another country, are US now', () => {
    const cases: Array<[typed: string, us: string]> = [
      ['+2125550147', '+12125550147'], // was refused (Morocco is +212, too short)
      ['+718 555 0199', '+17185550199'], // was refused
      ['+347 555 0123', '+13475550123'], // was refused
      ['+646 555 0123', '+16465550123'], // was New Zealand
      ['+516 555 0123', '+15165550123'], // was Peru
      ['+929 555 0123', '+19295550123'], // was Pakistan
      ['+201 555 0123', '+12015550123'], // was Egypt
      ['+914 555 0123', '+19145550123'], // was India
    ]
    for (const [typed, us] of cases) expect(toE164(typed), typed).toBe(us)
  })

  it('Canada and the Caribbean share +1, so the same rule holds there', () => {
    expect(toE164('+416 555 0123')).toBe('+14165550123')
    expect(toE164('+876 555 0123')).toBe('+18765550123')
  })

  it('a "0" typed after the "+" and the first digits gives the same number, and the stored form reads back as itself', () => {
    // libphonenumber drops the "0" as a national prefix; the result is "+" and
    // the same 10 digits, so it must read the same way as without the "0".
    for (const typed of ['+64 (0)6 555 0123', '+64 06 555 0123', '+646 555 0123']) expect(toE164(typed), typed).toBe('+16465550123')
    expect(toE164('+51 (0)6 555 0123')).toBe('+15165550123')
    for (const typed of ['+917 555 0123', '+64 (0)6 555 0123', '+51 (0)6 555 0123', '+44 20 7946 0750', '+44 (0)20 7946 0750', '+61 2 5550 0123', '+555 555 0123', '+1 555 555 0101']) {
      const once = toE164(typed)
      expect(once && toE164(once), typed).toBe(once)
    }
  })

  it('an extension is dropped from the stored form, as for every other number', () => {
    expect(toE164('+917 555 0123 ext 5')).toBe('+19175550123')
    expect(toE164('+917 555 0123 x5')).toBe('+19175550123')
  })
})

describe('what does not change', () => {
  it('a number already starting +1 reads as before', () => {
    for (const typed of ['+19175550123', '+1 917 555 0123', '+1-917-555-0123', '+1 (917) 555-0123', '19175550123', '917-555-0123', '(917) 555-0123']) {
      expect(toE164(typed), typed).toBe('+19175550123')
    }
    expect(toE164('+1 555 555 0101')).toBe('+15555550101')
  })

  it('a real international number (more than 10 digits after the "+") stays foreign', () => {
    expect(toE164('+44 20 7946 0750')).toBe('+442079460750') // UK, 12 digits (Ofcom's fictional range)
    expect(toE164('+91 212 555 0123')).toBe('+912125550123') // India: +91 and a full 10-digit number
    expect(toE164('+61 2 5550 0123')).toBe('+61255500123') // Australia, 11 digits (ACMA's fictional range)
  })

  it('10 digits that are no US number keep their old reading', () => {
    expect(toE164('+555 555 0123')).toBe('+5555550123') // 555 is not an area code
    expect(toE164('+911 555 0123')).toBe('+9115550123') // nor is 911
    expect(toE164('+212 055 0123')).toBeNull() // an exchange can't start with 0
    expect(toE164('+0125550123')).toBeNull()
  })

  it('9 or 11 digits after the "+" are never made into a US number', () => {
    expect(toE164('+917555012')).toBeNull()
    expect(toE164('+91755501234')).toBe('+91755501234')
  })

  it('anything that is not a phone number is still refused', () => {
    for (const bad of ['', '   ', '+', '++9175550123', 'garbage', '12345', null, undefined]) expect(toE164(bad), String(bad)).toBeNull()
  })
})
