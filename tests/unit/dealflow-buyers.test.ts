import { describe, it, expect } from 'vitest'
import { buyerName, buyerWants, toBuyers, type DealflowBuyer } from '@/lib/core-data/dealflow-sync/buyers'
import { captureLabel, reasonLabel, reasonList, reasonText, timezoneLabel } from '@/lib/core-data/dealflow-sync/labels'
import { BUYERS_SQL, RO_SQL, buildSignals, type DealflowJoinRow } from '@/lib/core-data/dealflow-sync/sync'

// Brief 38 — matching buyers on the seller card, and plain-English labels.

const buyer = (over: Partial<DealflowBuyer> = {}): DealflowBuyer => ({
  matchId: 'm_1', score: 95, tier: 'HOT', reasonKeys: ['neighborhood', 'beds', 'propertyType'], captureStatus: 'EXTERNAL_BOTH',
  type: 'opportunity', name: 'Jessica Martin', brokerage: 'Compass', neighborhoods: ['Bed-Stuy', 'Crown Heights'],
  propertyTypes: ['2-Family', 'Three-Family', 'Fourplex'], bedsMin: 3, bedsMax: null, priceMin: 1_350_000, priceMax: 2_600_000,
  buyerArchetype: null, isTestData: true, ...over,
})

describe('plain-English labels', () => {
  it("uses the planner's words for the listed reason keys", () => {
    expect(
      ['neighborhood', 'beds', 'baths', 'propertyType', 'absenteeOwner', 'buyerArchetypeSituation', 'tenure', 'substitutionScarcity', 'recency'].map(reasonLabel)
    ).toEqual([
      'right neighborhood', 'bedrooms fit', 'bathrooms fit', 'right building type', 'owner lives elsewhere',
      'buyer type suits the situation', 'long-time owner', 'few other options for this buyer', 'recent buyer request',
    ])
  })

  it('reads a stored "a + b + c" reason (and a "Match: a + b" queue reason) as a sentence', () => {
    expect(reasonText('beds + absenteeOwner + baths')).toBe('Bedrooms fit, owner lives elsewhere, bathrooms fit')
    expect(reasonText('Match: cooldownPenalty + freshnessBoost')).toBe('Not called recently, new match')
    expect(reasonList(['price', 'highEquity'])).toBe('Price fits budget, high equity')
  })

  it('leaves sentences alone and splits unknown camelCase keys', () => {
    expect(reasonText('Never contacted')).toBe('Never contacted')
    expect(reasonText('Top 87-scored match')).toBe('Top 87-scored match')
    expect(reasonText(null)).toBeNull()
    expect(reasonLabel('someNewFeature')).toBe('some new feature')
    expect(reasonText('neighborhood + someNewFeature')).toBe('Right neighborhood, some new feature')
  })

  it('labels capture statuses and time zones', () => {
    expect(['OWN_BOTH_SIDES', 'OWN_BUYER_ONLY', 'OWN_LISTING_ONLY', 'EXTERNAL_BOTH'].map(captureLabel))
      .toEqual(['Both sides yours', 'Your buyer', 'Your listing', 'Neither side yours yet'])
    expect(captureLabel('SOMETHING_NEW')).toBe('Something new')
    expect(captureLabel(null)).toBeNull()
    expect(timezoneLabel('America/New_York')).toBe('Eastern')
    expect(timezoneLabel('Europe/London')).toBe('Europe/London')
    expect(timezoneLabel(null)).toBeNull()
  })
})

describe('buyer display', () => {
  it("writes one line of what the buyer wants, like the brief's example", () => {
    expect(buyerWants(buyer())).toBe('2–4 family · Bed-Stuy, Crown Heights · 3+ BR · $1.35M–$2.6M')
  })

  it("normalizes DealFlow's building-type spellings and names the buyer type", () => {
    const b = buyer({
      propertyTypes: ['Multifamily', 'Duplex', 'Townhouse'], neighborhoods: ['Bedford-Stuyvesant'],
      bedsMin: 3, bedsMax: 6, priceMin: 1_636_666, priceMax: 3_618_051, buyerArchetype: 'INVESTOR_LANDLORD',
    })
    expect(buyerWants(b)).toBe('2-family, multifamily, townhouse · Bedford-Stuyvesant · 3–6 BR · $1.64M–$3.62M · investor')
    expect(buyerWants(buyer({ propertyTypes: ['SFH', 'Coop'], neighborhoods: ['A', 'B', 'C', 'D', 'E'], bedsMin: null, bedsMax: 2, priceMin: null, priceMax: 900_000 })))
      .toBe('Single-family, co-op · A, B, C, +2 · up to 2 BR · up to $900K')
  })

  it('names an inbox request by its agent and brokerage, a Mojo buyer by name', () => {
    expect(buyerName(buyer())).toBe('Jessica Martin · Compass')
    expect(buyerName(buyer({ brokerage: null }))).toBe('Jessica Martin')
    expect(buyerName(buyer({ name: null, brokerage: null }))).toBe('Inbox buyer request')
    expect(buyerName(buyer({ type: 'mojo', name: 'Pat Buyer', brokerage: null }))).toBe('Pat Buyer')
  })
})

describe('buyers from DealFlow', () => {
  it('keeps only the known fields (never a phone or email), at most 5, dropping rows without a match id', () => {
    const raw = [
      { ...buyer(), phone: '+15550000000', email: 'x@example.com', sourceAgentEmail: 'agent@example.com' },
      { score: 90 },
      ...[2, 3, 4, 5, 6].map((i) => buyer({ matchId: `m_${i}` })),
    ]
    const out = toBuyers(raw)
    expect(out.map((b) => b.matchId)).toEqual(['m_1', 'm_2', 'm_3', 'm_4', 'm_5'])
    expect(Object.keys(out[0]).sort()).toEqual(Object.keys(buyer()).sort())
    expect(JSON.stringify(out)).not.toMatch(/phone|email|5550000000/i)
    expect(toBuyers(null)).toEqual([])
  })

  it('stores them on the signal, whitelisted', () => {
    const row = { mojo_id: 'mojo_1', crm_lead_id: 'lead_1', generated_at: '2026-09-28T09:18:08Z', buyers: [{ ...buyer(), phone: '+15550000000' }] }
    const [s] = buildSignals({ includeTestBuyers: true, rows: [row as unknown as DealflowJoinRow] })
    expect(s.dealflowRawJson.buyers).toEqual([buyer()])
  })

  it("pulls each seller's primary + contributing matches, max 5, best first, and selects no contact details", () => {
    expect(RO_SQL).toContain(BUYERS_SQL)
    expect(BUYERS_SQL).toContain('array_prepend(cqe."primaryMatchId", cqe."contributingMatchIds")')
    expect(BUYERS_SQL).toMatch(/ORDER BY x\.ord LIMIT 5/)
    expect(BUYERS_SQL).toContain('ORDER BY b."score" DESC')
    expect(RO_SQL).not.toMatch(/phone|email/i)
  })

  it("reads buyer facts the way DealFlow's matcher does", () => {
    expect(BUYERS_SQL).toContain('COALESCE(eo."minPrice", eo."price", bc."budgetMin")')
    expect(BUYERS_SQL).toContain('COALESCE(eo."minBeds", eo."beds", bc."bedsMin")')
    expect(BUYERS_SQL).toContain('NULLIF(bc."initialNeighborhood", \'\')')
    expect(BUYERS_SQL).toContain(`CASE WHEN bc."cashOnly" THEN 'CASH_BUYER' END`)
  })
})
