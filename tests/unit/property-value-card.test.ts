import { describe, it, expect } from 'vitest'
import { createElement as h } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { PropertyValueCard } from '@/app/leads/[id]/PropertyValueCard'
import { toPropertyFacts, type DealflowProperty } from '@/lib/core-data/dealflow-sync/property'
import { comp, facts, rawProperty } from './helpers/property-fixture'

// Brief 44 (PR 5): the "Property value and facts" card on Ryan's lead page.
// One value and one range, no confidence label, and no buttons or option
// selections anywhere (Ryan's instructions, 2026-10-04). Invented data only.

const render = (property: DealflowProperty | null) => renderToStaticMarkup(h(PropertyValueCard, { property }))
const decode = (s: string) =>
  s.replace(/&#x27;/g, "'").replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&')
const text = (html: string) => decode(html.replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim()
// [label, value] of each fact row, in order.
const factRows = (html: string) => [...html.matchAll(/<dt[^>]*>(.*?)<\/dt><dd[^>]*>(.*?)<\/dd>/g)].map((m) => [decode(m[1]), decode(m[2])])
// [address, details] of each nearby sale, in order.
const saleRows = (html: string) => [...html.matchAll(/<li[^>]*><p[^>]*>(.*?)<\/p><p[^>]*>(.*?)<\/p><\/li>/g)].map((m) => [decode(m[1]), decode(m[2])])
const property = (over: Record<string, unknown> = {}) => toPropertyFacts(rawProperty(over)) as DealflowProperty
const eight = () => Array.from({ length: 8 }, (_, i) => comp(i))
const NO_VALUE = { value: null, low: null, high: null, comps: [] }

// Anything a person could press or pick.
const CONTROLS = /<(button|select|option|input|textarea|form)\b|role="(button|radio|radiogroup|checkbox|switch|listbox|option|menu|tab)"/i

describe('PropertyValueCard', () => {
  it('with a value: value and range on one line, the as-of date, up to 5 nearby sales, the facts and the sources', () => {
    const html = render(property({ comps: eight() }))
    const t = text(html)
    expect(t).toContain('$1.83M — likely $1.54M–$2.12M')
    expect(t).toContain('As of Oct 1, 2026')
    expect(t).toContain('DealFlow estimate · only you see this')
    expect(saleRows(html)).toEqual([
      ['12 Example St', 'Sep 12, 2026 · $1.75M · $712/sq ft · 0.1 mi'],
      ['14 Example St', 'Sep 11, 2026 · $1.7M · $702/sq ft · 0.2 mi'],
      ['16 Example St', 'Sep 10, 2026 · $1.65M · $692/sq ft · 0.3 mi'],
      ['18 Example St', 'Sep 9, 2026 · $1.6M · $682/sq ft · 0.4 mi'],
      ['20 Example St', 'Sep 8, 2026 · $1.55M · $672/sq ft · 0.5 mi'],
    ])
    expect(factRows(html)).toEqual([
      ['Units', '2'],
      ['Building size', '2,400 sq ft'],
      ['Lot size', '2,000 sq ft'],
      ['Year built', '1910'],
      ['Floors', '3'],
      ['Zoning', 'R6B'],
      ['Building class', 'B1'],
      ['Historic district', 'No'],
      ['Last sale', '$1.2M · Jun 3, 2015'],
      ['City market value', '$1.41M (FY2027)'],
      ['Permits (7 yrs)', '2 alteration permits (major)'],
      ['Open violations', 'DOB 0 · ECB 1 · HPD 0'],
      ['Nearest subway', '0.3 mi'],
      ['Lead vs city', 'Units: lead says 3, city says 2'],
    ])
    expect(t.endsWith('Sources: PLUTO 26v2 · DOF FY2027 roll · city sales through Sep 30, 2026 · public records downloaded Oct 18, 2026')).toBe(true)
  })

  it('without a value: one sentence saying why, and the facts still show', () => {
    const why = {
      five_plus_units: "5+ unit building: the city values these on income, so there's no model value.",
      condo_without_unit: "Condo building, but this lead has no unit number, so the unit can't be valued.",
      other_property_type: "Not a 1–4 family home (for example a condo unit, garage, store or mixed-use lot), so there's no model value.",
    }
    for (const [reason, sentence] of Object.entries(why)) {
      const html = render(property({ ...NO_VALUE, reason, facts: facts({ units: 6 }) }))
      const t = text(html)
      expect(t, reason).toContain(sentence)
      expect(t, reason).not.toMatch(/likely|As of/)
      expect(saleRows(html), reason).toEqual([])
      expect(factRows(html), reason).toContainEqual(['Units', '6'])
      expect(t, reason).toContain('Sources: PLUTO 26v2')
    }
  })

  it("not found: says the address didn't match a city tax lot, with no facts", () => {
    const html = render(property({ ...NO_VALUE, reason: 'not_found', facts: null }))
    expect(text(html)).toContain("We couldn't match this address to a city tax lot.")
    expect(factRows(html)).toEqual([])
    expect(saleRows(html)).toEqual([])
  })

  it('before any run, or no valuation for this lead: "No value yet"', () => {
    expect(text(render(null))).toBe('No value yet')
  })

  it('a run that named no sources still dates its sales from the run itself', () => {
    expect(text(render(property({ sources: null })))).toContain('Sources: city sales through Sep 30, 2026')
  })

  it('no buttons or option selections in any state, and no confidence label', () => {
    const states = [
      property({ comps: eight() }),
      property({ ...NO_VALUE, reason: 'five_plus_units' }),
      property({ ...NO_VALUE, reason: 'not_found', facts: null }),
      null,
    ]
    for (const p of states) {
      const html = render(p)
      expect(html).not.toMatch(CONTROLS)
      expect(text(html)).not.toMatch(/confiden/i)
    }
  })

  it('fits a phone: no table and no text forced onto one line', () => {
    const html = render(property({ comps: eight() }))
    expect(html).not.toMatch(/<table|whitespace-nowrap|overflow-x|truncate/)
  })

  it('shows only the facts the city has, and lead-vs-city lines only where they disagree', () => {
    const html = render(
      property({
        facts: facts({
          zoning: null, subwayMiles: null, historicDistrict: true, permits7y: { count: 0, major: false },
          openViolations: { dob: 0, ecb: 0, hpd: 0 },
          leadVsCity: { units: { lead: 2, city: 2 }, buildingSqft: { lead: 2600, city: 2400 } },
        }),
      })
    )
    const rows = factRows(html)
    expect(rows.map(([label]) => label)).not.toContain('Zoning')
    expect(rows.map(([label]) => label)).not.toContain('Nearest subway')
    expect(rows).toContainEqual(['Historic district', 'Yes'])
    expect(rows).toContainEqual(['Permits (7 yrs)', 'No alteration permits'])
    expect(rows).toContainEqual(['Open violations', 'None'])
    const one = factRows(render(property({ facts: facts({ permits7y: { count: 1, major: false } }) })))
    expect(one).toContainEqual(['Permits (7 yrs)', '1 alteration permit'])
    expect(rows.filter(([label]) => label === 'Lead vs city')).toEqual([
      ['Lead vs city', 'Building size: lead says 2,600 sq ft, city says 2,400 sq ft'],
    ])
  })
})
