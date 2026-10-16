import { describe, it, expect } from 'vitest'
import { normalizeStreet, sameStreet } from '@/lib/core-data/importer/address'

// Brief 41.1 (F10): which addresses name the same property, for import
// matching. The reviewer's probe (probe-import-dsl "sameStreet false
// positives") found units, suffix words and street-less lines matching.

describe('sameStreet: different properties never match', () => {
  const different: Array<[string | null, string | null, string]> = [
    ['361 Degraw St # 3, Brooklyn', '361 Degraw St Apt 4, Brooklyn', 'another unit'],
    ['361 Degraw St #3', '361 Degraw St Unit 4B', 'another unit'],
    ['361 Degraw St, Apt 3, Brooklyn, NY', '361 Degraw St, Apt 4, Brooklyn, NY', 'another unit (in its own part)'],
    // Brief 41.1 review: a unit written without a marker, a floor, a unit word.
    ['123 Main St 4B, Brooklyn, NY', '123 Main St 5A, Brooklyn, NY', 'another bare unit'],
    ['123 Main St 4B Brooklyn NY 11201', '123 Main St 5A Brooklyn NY 11201', 'another bare unit (one cell)'],
    ['361 Degraw St 2F', '361 Degraw St 3F', 'another bare unit'],
    ['361 Degraw St 2F', '361 Degraw St Apt 3F', 'another unit, one bare'],
    ['123 Main St 4', '123 Main St 5', 'another bare unit number'],
    ['123 Main St, 4B', '123 Main St, 5A', 'another bare unit (in its own part)'],
    ['123 Main St PH1', '123 Main St PH2', 'another penthouse'],
    ['361 Degraw St Apt PH', '361 Degraw St Apt 4', 'the penthouse vs a unit'],
    ['361 Degraw St Rear', '361 Degraw St Front', 'rear vs front'],
    ['361 Degraw St Bsmt', '361 Degraw St 1st Fl', 'the basement vs a floor'],
    ['361 Degraw St, 2nd Floor', '361 Degraw St, Fl 3', 'another floor'],
    ['123 Main St 11201', '123 Main St 11215', 'another ZIP'],
    ['123 Main St, Brooklyn, NY 11201', '123 Main St, Brooklyn, NY 11215', 'another ZIP'],
    ['12 Main St, Brooklyn, NY', '12 Main St Extension, Brooklyn', 'a suffix word'],
    ['100 Flatbush Ave, Brooklyn', '100 Flatbush Avenue Extension', 'a suffix word'],
    ['10 Ocean Pkwy, Brooklyn', '10 Ocean Pkwy N, Brooklyn', 'a suffix word'],
    ['12, Brooklyn, NY', '12 Main St, Brooklyn', 'a stored line with only a house number'],
    ['12', '12 Main St', 'a stored line with only a house number'],
    ['12', '12', 'two bare house numbers'],
    ['Brooklyn, NY 11201', 'Brooklyn Ave 5, Brooklyn', 'a city only'],
    ['Brooklyn, NY 11201', 'Brooklyn, NY 11201', 'a city only, twice'],
    ['Brooklyn', '12 Brooklyn Ave', 'a city only vs a street named after it'],
    ['100 Oak St, Brooklyn', '10 Oak St, Brooklyn', 'another house number'],
    ['12 Main St', '12A Main St', 'another house number'],
    ['1 W 2nd St', '1 E 2nd St', 'another direction'],
    ['200 Sterling Pl', '200 Sterling St', 'another street type'],
    ['5 Main St', '5 Maine St', 'another street'],
    [null, '5 Main St', 'no address'],
    ['', '', 'no address'],
  ]
  for (const [a, b, why] of different) {
    it(`${a} | ${b} (${why})`, () => {
      expect(sameStreet(a, b)).toBe(false)
      expect(sameStreet(b, a)).toBe(false)
    })
  }
})

describe('sameStreet: spellings of one property still match', () => {
  const same: Array<[string, string]> = [
    ['2 Pine St, Brooklyn', '2 Pine St Brooklyn NY 11201'], // one cell, city after the street
    ['4 Cedar St, Brooklyn, NY 11201', '4 Cedar St Brooklyn NY 11201'],
    ['2 Pine St, Brooklyn, NY 11201', '2 Pine Street'],
    ['30 Elm St, Brooklyn, NY 11217', '30 Elm Street'],
    ['18-14 Main St, Queens', '1814 Main Street'],
    ['115 St Marks Ave', '115 Saint Marks Avenue'],
    ["87 St John's Pl, Brooklyn", '87 Saint Johns Place'],
    ['1 E 2nd St', '1 East 2 Street, Brooklyn'],
    ['10 MAIN ST.', '10 main street'],
    ['361 Degraw St # 3, Brooklyn', '361 Degraw Street Apt 3'], // same unit
    ['361 Degraw St #03', '361 Degraw St Unit 3'],
    ['361 Degraw St, Brooklyn', '361 Degraw St Apt 3, Brooklyn'], // a unit on one side only
    ['123 Main St 4B', '123 Main St Apt 4B'], // a bare unit = the same unit with a marker
    ['123 Main St, 4B, Brooklyn', '123 Main St #4B'],
    ['361 Degraw St Apt 2F', '361 Degraw St 2F'],
    ['123 Main St 4B, Brooklyn', '123 Main St, Brooklyn'], // a bare unit on one side only
    ['361 Degraw St Rear', '361 Degraw St'],
    ['361 Degraw St PH', '361 Degraw St #PH'],
    ['361 Degraw St Penthouse', '361 Degraw St PH'],
    ['361 Degraw St PH 1', '361 Degraw St PH1'],
    ['361 Degraw St 2nd Fl', '361 Degraw St Floor 2'],
    ['361 Degraw St Apt 3-R', '361 Degraw St #3R'],
    ['4 Cedar St, Brooklyn, NY 11201', '4 Cedar St Brooklyn NY 11201-1234'], // the same ZIP (ZIP+4)
    ['21410 Northern Blvd, Bayside, NY 11361', '214-10 Northern Blvd Bayside NY 11361'], // a 5-digit house number isn't a ZIP
    ['2 Pine St, Brooklyn', '2 Pine, Brooklyn'], // a type on one side only
    ['100 Flatbush Ave Ext', '100 Flatbush Avenue Extension, Brooklyn'],
    ['10 Ocean Pkwy N', '10 Ocean Parkway North, Brooklyn'],
    ['1 Plaza St E, Brooklyn', '1 Plaza Street East'],
    ['100 Court St', '100 Court Street Brooklyn NY 11201'],
    ['1 Avenue J, Brooklyn', '1 Avenue J Brooklyn NY 11230'],
    ['200 Prospect Park W', '200 Prospect Park West, Brooklyn'],
    ['12 Brooklyn Ave, Brooklyn', '12 Brooklyn Ave Brooklyn NY 11213'],
    ['1 Grand Army Plz', '1 Grand Army Plaza, Brooklyn'],
  ]
  for (const [a, b] of same) {
    it(`${a} | ${b}`, () => {
      expect(sameStreet(a, b)).toBe(true)
      expect(sameStreet(b, a)).toBe(true)
    })
  }
})

describe('normalizeStreet (row grouping) is unchanged', () => {
  // A stopped import resumes by group index: the grouping key must not move.
  it('keeps the Brief 41 behaviour', () => {
    expect(normalizeStreet('361 Degraw St # 3')).toBe('361 degraw street')
    expect(normalizeStreet('115 St Marks Ave')).toBe('115 saint marks avenue')
    expect(normalizeStreet('18-14 Main St')).toBe('1814 main street')
    expect(normalizeStreet('2 Pine St Brooklyn NY 11201')).toBe('2 pine street brooklyn ny 11201')
    expect(normalizeStreet('12')).toBe('12')
    expect(normalizeStreet('')).toBeNull()
  })
})
