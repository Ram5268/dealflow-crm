import { describe, it, expect } from 'vitest'
import { buildSignals, dealflowDeepLink, type DealflowJoinRow } from '@/lib/core-data/dealflow-sync/sync'

const row = (over: Partial<DealflowJoinRow> = {}): DealflowJoinRow => ({
  mojo_id: 'mojo_1',
  crm_lead_id: 'lead_1',
  queue_rank: 1,
  priority_score: 93,
  queue_reason: 'Top match',
  primary_match_id: 'm_1',
  primary_match_fit: 94.6,
  primary_capture_status: 'OWN_BUYER_ONLY',
  primary_match_confidence: 'high',
  match_reason: 'Strong buyer fit',
  contactId: 'c_1',
  contributions: { matchFitLift: 32 },
  generation_run_id: 'run_1',
  generated_at: '2026-08-24T06:14:36.587Z',
  ...over,
})
const batch = (rows: DealflowJoinRow[], includeTestBuyers: boolean | null = true) => ({ rows, includeTestBuyers })

describe('buildSignals', () => {
  it('maps a joined row to a derived-signal upsert', () => {
    const [s] = buildSignals(batch([row()]))
    expect(s.mojoId).toBe('mojo_1')
    expect(s.crmLeadId).toBe('lead_1')
    expect(s.queueRank).toBe(1)
    expect(s.priorityScore).toBe(93)
    expect(s.queueReason).toBe('Top match')
    expect(s.primaryMatchId).toBe('m_1')
    expect(s.primaryMatchFit).toBe(95) // 94.6 rounded
    expect(s.primaryCaptureStatus).toBe('OWN_BUYER_ONLY')
    expect(s.primaryMatchConfidence).toBe('high')
    expect(s.matchReason).toBe('Strong buyer fit')
    expect(s.dealflowDeepLink).toMatch(/\/matches\?m=m_1$/)
    expect(s.dealflowRawJson.generatedAt).toBe('2026-08-24T06:14:36.587Z')
  })

  it('stores the run facts (run id, includeTestBuyers) with every signal', () => {
    const [s] = buildSignals(batch([row()], true))
    expect(s.dealflowRawJson.generationRunId).toBe('run_1')
    expect(s.dealflowRawJson.includeTestBuyers).toBe(true)
    expect(buildSignals(batch([row()], null))[0].dealflowRawJson.includeTestBuyers).toBeNull()
  })

  it('drops rows with no mojoId (nothing to join)', () => {
    expect(buildSignals(batch([row({ mojo_id: null })]))).toHaveLength(0)
  })

  it('matchReason falls back to queueReason when match reason absent', () => {
    const [s] = buildSignals(batch([row({ match_reason: null, queue_reason: 'Queue only' })]))
    expect(s.matchReason).toBe('Queue only')
  })

  it('null numeric fields stay null (never fabricated)', () => {
    const [s] = buildSignals(batch([row({ priority_score: null, primary_match_fit: null })]))
    expect(s.priorityScore).toBeNull()
    expect(s.primaryMatchFit).toBeNull()
  })

  it('deep link opens the top match on /matches; no match → no link', () => {
    expect(dealflowDeepLink('m_9')).toBe('https://dealflow-inbox-intelligence.vercel.app/matches?m=m_9')
    expect(dealflowDeepLink('a b&c')).toMatch(/\/matches\?m=a%20b%26c$/)
    expect(dealflowDeepLink(null)).toBeNull()
    expect(buildSignals(batch([row({ primary_match_id: null })]))[0].dealflowDeepLink).toBeNull()
  })

  it('serializes a Date generated_at to ISO', () => {
    const [s] = buildSignals(batch([row({ generated_at: new Date('2026-01-02T03:04:05.000Z') })]))
    expect(s.dealflowRawJson.generatedAt).toBe('2026-01-02T03:04:05.000Z')
  })

  it('handles all-null optional fields without fabricating (null branches)', () => {
    const [s] = buildSignals(
      batch([
        row({
          crm_lead_id: null,
          queue_rank: null,
          queue_reason: null,
          primary_match_id: null,
          primary_capture_status: null,
          primary_match_confidence: null,
          match_reason: null,
          contributions: null,
          generation_run_id: null,
          generated_at: null,
        }),
      ])
    )
    expect(s.crmLeadId).toBeNull()
    expect(s.queueRank).toBeNull()
    expect(s.queueReason).toBeNull()
    expect(s.primaryMatchId).toBeNull()
    expect(s.matchReason).toBeNull() // both match_reason and queue_reason null
    expect(s.dealflowDeepLink).toBeNull()
    expect(s.dealflowRawJson.contributions).toBeNull()
    expect(s.dealflowRawJson.generatedAt).toBeNull()
  })
})
