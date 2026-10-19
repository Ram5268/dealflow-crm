import { describe, it, expect } from 'vitest'
import { refuseBatch } from '@/lib/core-data/dealflow-sync/write'

// Brief 50 (PR 11), open item 6.10, an engineering precaution: the 7:00 copy
// treats DealFlow's call list as complete and clears every lead missing from
// it, so a list that matches no CRM lead (or only a few) would blank the
// Queue. Such a list is refused and nothing is written; yesterday's copy
// stays. "Few" is Brief 47's rule for DealFlow's own nightly: fewer than half
// as many as last time. Here "last time" is the number of signals the last
// morning copy left (an upload's scoring rows don't count). Pure; the DB
// proof is tests/dealflow-sync.safety.test.ts.

describe('refuseBatch', () => {
  it('a list that matches no CRM lead is always refused', () => {
    expect(refuseBatch({ mappedLeads: 0, morningSignals: 0 })).toBe('no_leads_matched')
    expect(refuseBatch({ mappedLeads: 0, morningSignals: 1_490 })).toBe('no_leads_matched')
  })

  it('fewer than half as many leads as the last morning held signals: refused; half or more: copied', () => {
    expect(refuseBatch({ mappedLeads: 744, morningSignals: 1_490 })).toBe('too_few_leads_matched')
    expect(refuseBatch({ mappedLeads: 745, morningSignals: 1_490 })).toBeNull()
    expect(refuseBatch({ mappedLeads: 1, morningSignals: 3 })).toBe('too_few_leads_matched')
    expect(refuseBatch({ mappedLeads: 2, morningSignals: 4 })).toBeNull()
  })

  it("a normal morning passes with about a 2x margin (today's shape: ~1,478 leads from a ~1,490-entry list)", () => {
    expect(refuseBatch({ mappedLeads: 1_478, morningSignals: 1_490 })).toBeNull()
    // A list that grows, or a first copy with nothing before it, is never refused.
    expect(refuseBatch({ mappedLeads: 2_000, morningSignals: 1_490 })).toBeNull()
    expect(refuseBatch({ mappedLeads: 5, morningSignals: 0 })).toBeNull()
  })
})
