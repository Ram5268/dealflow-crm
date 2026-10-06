import { describe, it, expect } from 'vitest'
import { planPhoneBackfill } from '@/lib/compliance/dnc/phoneBackfill'

// Brief 41 (H13): rewriting phones stored before canonical E.164.
const dnc = (id: string, phone: string, source = 'internal', organizationId = 'o1') => ({ id, organizationId, source, phone })

describe('planPhoneBackfill', () => {
  it('rewrites opt-out rows to canonical form, leaves canonical ones alone', () => {
    const plan = planPhoneBackfill([dnc('a', '9173312047'), dnc('b', '+12125550101'), dnc('c', '1-718-555-0102')], [])
    expect(plan.dnc.rewrite).toEqual([{ id: 'a', phone: '+19173312047' }, { id: 'c', phone: '+17185550102' }])
    expect(plan.dnc.alreadyCovered).toEqual([])
  })

  it('never creates a second canonical row for a number (the unique org/phone/source index): extra formats stay', () => {
    const plan = planPhoneBackfill([dnc('a', '+19173312047'), dnc('b', '9173312047'), dnc('c', '(917) 331-2047')], [])
    expect(plan.dnc.rewrite).toEqual([])
    expect(plan.dnc.alreadyCovered).toEqual(['b', 'c'])
    const noCanonical = planPhoneBackfill([dnc('b', '9173312047'), dnc('c', '19173312047')], [])
    expect(noCanonical.dnc.rewrite).toEqual([{ id: 'b', phone: '+19173312047' }])
    expect(noCanonical.dnc.alreadyCovered).toEqual(['c'])
  })

  it('treats each org and source separately', () => {
    const plan = planPhoneBackfill([dnc('a', '9173312047', 'internal', 'o1'), dnc('b', '9173312047', 'internal', 'o2'), dnc('c', '9173312047', 'federal', 'o1')], [])
    expect(plan.dnc.rewrite.map((r) => r.id)).toEqual(['a', 'b', 'c'])
  })

  it('reports values that are not phone numbers and never changes them', () => {
    const plan = planPhoneBackfill([dnc('a', 'n/a')], [{ id: 'p1', phone: 'call office' }, { id: 'p2', phone: '(917) 331-2047' }, { id: 'p3', phone: '+19173312047' }])
    expect(plan.dnc).toEqual({ rewrite: [], alreadyCovered: [], unparseable: ['a'] })
    expect(plan.contactPhones).toEqual({ rewrite: [{ id: 'p2', phone: '+19173312047' }], unparseable: ['p1'] })
  })
})
