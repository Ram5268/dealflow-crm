import { describe, it, expect } from 'vitest'
import { refuseBatch } from '@/lib/core-data/dealflow-sync/write'

// Brief 50 (PR 11), open item 6.10, an engineering precaution: the 7:00 copy
// treats DealFlow's call list as complete and clears every lead missing from
// it, so a list that matches no CRM lead (or only a few) would blank the
// Queue. Such a list is refused and nothing is written; yesterday's copy
// stays. "Few" is Brief 47's rule for DealFlow's own nightly: fewer than half
// as many as last time. Brief 50 (PR 19, the planner's review): "last time"
// is the number of the organization's leads the last morning copy reached,
// counted the way the new list's leads are (like with like), no longer the
// signal rows it left (an upload's scoring rows never counted). Pure; the DB
// proofs are tests/dealflow-sync.safety.test.ts and
// tests/dealflow-sync.refusal-notice.test.ts.

describe('refuseBatch', () => {
  it('a list that matches no CRM lead is always refused', () => {
    expect(refuseBatch({ mappedLeads: 0, lastCopyLeads: 0 })).toBe('no_leads_matched')
    expect(refuseBatch({ mappedLeads: 0, lastCopyLeads: 1_478 })).toBe('no_leads_matched')
  })

  it('fewer than half as many leads as the last copy reached: refused; half or more: copied', () => {
    expect(refuseBatch({ mappedLeads: 738, lastCopyLeads: 1_478 })).toBe('too_few_leads_matched')
    expect(refuseBatch({ mappedLeads: 739, lastCopyLeads: 1_478 })).toBeNull()
    expect(refuseBatch({ mappedLeads: 1, lastCopyLeads: 3 })).toBe('too_few_leads_matched')
    expect(refuseBatch({ mappedLeads: 2, lastCopyLeads: 4 })).toBeNull()
  })

  it("a normal morning passes with about a 2x margin (today's shape: ~1,478 leads reached, then and now)", () => {
    expect(refuseBatch({ mappedLeads: 1_478, lastCopyLeads: 1_478 })).toBeNull()
    // A list that grows, or a first copy with nothing before it, is never refused.
    expect(refuseBatch({ mappedLeads: 2_000, lastCopyLeads: 1_478 })).toBeNull()
    expect(refuseBatch({ mappedLeads: 5, lastCopyLeads: 0 })).toBeNull()
  })
})
