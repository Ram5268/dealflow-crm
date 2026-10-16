import { describe, it, expect } from 'vitest'
import { isRealName, leadRealNames, nameWords, namesConflict, sameName } from '@/lib/core-data/importer/names'

// Brief 41.1 (F10): a phone match where both sides have different real names
// is a different person.

describe('isRealName', () => {
  it('a person or a company is a name', () => {
    for (const n of ['Alice Owner', 'OWNER, ALICE', 'José Núñez', 'Acme Holdings LLC', 'Estate of John Smith', 'Mary-Kate O’Brien']) {
      expect(isRealName(n)).toBe(true)
    }
  })
  it('placeholders are not: "Imported Lead", the address, the Mojo ID, numbers, initials, blanks', () => {
    expect(isRealName('Imported Lead')).toBe(false)
    expect(isRealName('imported  lead')).toBe(false)
    expect(isRealName('12 Main St, Brooklyn, NY', { address: '12 Main St, Brooklyn, NY' })).toBe(false)
    expect(isRealName('12 Main St', { address: '12 Main St, Brooklyn, NY' })).toBe(false)
    expect(isRealName('5 Oak St')).toBe(false) // an old address kept as the name
    expect(isRealName('MOJO-123', { mojoId: 'MOJO-123' })).toBe(false)
    expect(isRealName('12345678')).toBe(false)
    expect(isRealName('J.')).toBe(false)
    expect(isRealName('Mr.')).toBe(false)
    expect(isRealName('')).toBe(false)
    expect(isRealName(null)).toBe(false)
  })
  it('list placeholders, a city, a unit or an email are not names (Brief 41.1 review)', () => {
    for (const n of ['Unknown', 'Current Resident', 'Or Current Resident', 'Occupant', 'Homeowner', 'Owner', 'NA', 'N/A', 'None', 'Seller', 'Test', 'Test Lead', 'Unknown Unknown', 'Brooklyn, NY', 'Apt 3', 'john@x.com']) {
      expect(isRealName(n), n).toBe(false)
    }
    // ...while a real name may contain such a word.
    for (const n of ['Alice Owner', 'Jane Doe or Current Resident', 'Brooklyn Decker', '1st Choice Realty', '3 Brothers LLC', 'Park Place Realty']) {
      expect(isRealName(n), n).toBe(true)
    }
  })
})

describe('sameName', () => {
  it('forgives case, punctuation, word order, initials, titles, accents and an added co-owner', () => {
    expect(nameWords('SMITH, Robert J. Jr.')).toEqual(['smith', 'robert'])
    for (const [a, b] of [
      ['Alice Owner', 'OWNER, Alice Q.'],
      ['Alice Owner', 'alice owner'],
      ['Alice Owner', 'Mrs. Alice Owner'],
      ['Alice & Bob Owner', 'Alice Owner'],
      ['Estate of John Smith', 'John Smith'],
      ['Jose Nunez', 'José Núñez'],
      ['Smith', 'Jane Smith'],
      // Brief 41.1 review: an apostrophe or a space in a particle.
      ["Patrick O'Brien", 'Patrick OBrien'],
      ['Patrick OBrien', 'Patrick O Brien'],
      ['Mary McDonald', 'Mary Mc Donald'],
      ['Ann DeLuca', 'Ann De Luca'],
      ['Mohammed Al-Rashid', 'Mohammed AlRashid'],
      ['Mohammed AlRashid', 'Mohammed Al Rashid'],
      ['Hans Van Der Berg', 'Hans Vanderberg'],
      ['D’Angelo Rossi', 'DAngelo Rossi'],
      ['Nguyen Van Minh', 'Minh Nguyen'],
    ]) {
      expect(sameName(a, b)).toBe(true)
      expect(sameName(b, a)).toBe(true)
    }
  })
  it('different people differ', () => {
    for (const [a, b] of [
      ['Alice Owner', 'Bob Owner'],
      ['Robert Smith', 'Bob Smith'],
      ['Alice Owner', 'Alice Smith'],
      ['Acme LLC', 'John Smith'],
    ]) {
      expect(sameName(a, b)).toBe(false)
    }
  })
})

describe('namesConflict', () => {
  it('only when both sides have real names and none agree', () => {
    expect(namesConflict(['Bob Owner'], ['Alice Owner'])).toBe(true)
    expect(namesConflict(['Bob Owner'], ['Alice Owner', 'Bob Owner'])).toBe(false) // the co-owner
    expect(namesConflict(['Alice Owner', 'Bob Owner'], ['Bob Owner'])).toBe(false)
    expect(namesConflict([], ['Alice Owner'])).toBe(false) // a phone-only row
    expect(namesConflict(['Bob Owner'], [])).toBe(false) // an unnamed lead
  })
})

describe('leadRealNames', () => {
  const lead = { name: null, displayName: 'Imported Lead', primaryAddressFull: null, mojoId: null, contacts: [] }
  it('an "Imported Lead" or an address-named lead has no real name', () => {
    expect(leadRealNames(lead)).toEqual([])
    expect(leadRealNames({ ...lead, displayName: '9 Elm St, Brooklyn', primaryAddressFull: '9 Elm St, Brooklyn', contacts: [{ name: null, displayName: '9 Elm St, Brooklyn' }] })).toEqual([])
    expect(leadRealNames({ ...lead, displayName: 'M77', mojoId: 'M77' })).toEqual([])
  })
  it("collects the owner, a hand-typed name and the contacts' names", () => {
    expect(leadRealNames({ ...lead, displayName: 'Paul Manual' })).toEqual(['Paul Manual'])
    expect(
      leadRealNames({ name: 'Alice Owner', displayName: 'Alice Owner', primaryAddressFull: '1 Pine St', mojoId: 'M1', contacts: [{ name: 'Bob Owner', displayName: 'Bob Owner' }] })
    ).toEqual(['Alice Owner', 'Bob Owner'])
  })
})
