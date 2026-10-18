import { describe, it, expect } from 'vitest'
import { leadFields, signalRow } from '@/lib/core-data/dealflow-score/write'
import { IMPORT_SCORING_SOURCE } from '@/lib/core-data/dealflow-score/marker'
import type { ScoreResponse, ScoredLead } from '@/lib/core-data/dealflow-score/request'
import { buildSignals, type DealflowJoinRow } from '@/lib/core-data/dealflow-sync/sync'

// Brief 45 PR F — what the CRM writes for each lead DealFlow scored on request
// (CONTRACT §7 step 4): the same five lead fields, computed the same way, as
// the morning sync writes from DealFlow's call list (sync.ts buildSignals +
// write.ts UPDATE_LEADS_SQL), and a signal row so "best buyer" shows. Pure.

const IMPORT = 'cimport0000000000000000001'
const buyer = {
  matchId: 'm_a', score: 91, tier: 'HOT', reasonKeys: ['neighborhood'], captureStatus: 'EXTERNAL_BOTH', type: 'opportunity',
  name: 'Test Agent', brokerage: 'Example Realty', neighborhoods: ['Bushwick'], propertyTypes: ['2-Family'], bedsMin: 3, bedsMax: 5,
  priceMin: 1_000_000, priceMax: 2_000_000, buyerArchetype: 'CASH_BUYER', isTestData: true,
}
const ranked: ScoredLead = {
  crmLeadId: 'lead_a', mojoId: 'mojo_a', priorityScore: 81.6, queueReason: 'Match: matchFitLift + freshnessBoost', primaryMatchId: 'm_a',
  primaryMatchFit: 88.4, primaryCaptureStatus: 'EXTERNAL_BOTH', primaryMatchConfidence: 'HIGH', matchReason: 'neighborhood + price',
  contributions: { matchFitLift: 30 },
  // A field that must never reach the CRM rides along on purpose.
  buyers: [{ ...buyer, phone: '+12125550100', email: 'agent@example.com' }],
  notRankedReason: null,
}
const unranked: ScoredLead = {
  crmLeadId: 'lead_b', mojoId: 'mojo_b', priorityScore: null, queueReason: null, primaryMatchId: null, primaryMatchFit: null,
  primaryCaptureStatus: null, primaryMatchConfidence: null, matchReason: null, contributions: null, buyers: [], notRankedReason: 'no_matches',
}
const response: ScoreResponse = {
  importId: IMPORT, generatedAt: '2026-10-18T19:00:00.000Z', includeTestBuyers: true, ms: 9000, scored: [ranked, unranked], skipped: [],
}

describe('lead fields: the same as the morning sync would write for this seller', () => {
  it('matches buildSignals for the same DealFlow row (rounded scores, reason fallback, deep link)', () => {
    const row: DealflowJoinRow = {
      mojo_id: 'mojo_a', crm_lead_id: 'lead_a', queue_rank: 7, priority_score: 81.6, queue_reason: ranked.queueReason,
      primary_match_id: 'm_a', primary_match_fit: 88.4, primary_capture_status: 'EXTERNAL_BOTH', primary_match_confidence: 'HIGH',
      match_reason: 'neighborhood + price', contactId: 'c_1', contributions: {}, generation_run_id: 'run', generated_at: '2026-10-18T09:00:00.000Z',
    }
    const [sync] = buildSignals({ rows: [row], includeTestBuyers: true })
    expect(leadFields(ranked)).toEqual({
      id: 'lead_a',
      mojoId: 'mojo_a',
      priorityScore: sync.priorityScore,
      topMatchFit: sync.primaryMatchFit,
      captureStatus: sync.primaryCaptureStatus,
      matchReason: sync.matchReason,
      dealflowDeepLink: sync.dealflowDeepLink,
    })
    expect(leadFields(ranked)).toMatchObject({ priorityScore: 82, topMatchFit: 88 })
    // No match reason: the queue reason, as the sync does.
    expect(leadFields({ ...ranked, matchReason: null }).matchReason).toBe(ranked.queueReason)
  })

  it('a seller DealFlow looked at but left unranked (no buyer match): every field empty', () => {
    expect(leadFields(unranked)).toEqual({
      id: 'lead_b', mojoId: 'mojo_b', priorityScore: null, topMatchFit: null, captureStatus: null, matchReason: null, dealflowDeepLink: null,
    })
  })
})

describe('signal rows (so "best buyer" shows)', () => {
  it('a ranked seller gets one, with whitelisted buyers and no contact details', () => {
    const s = signalRow(ranked, response, IMPORT)!
    expect(s).toMatchObject({
      mojoId: 'mojo_a', priorityScore: 82, queueReason: ranked.queueReason, primaryMatchId: 'm_a', primaryMatchFit: 88,
      primaryCaptureStatus: 'EXTERNAL_BOTH', primaryMatchConfidence: 'HIGH',
    })
    const raw = s.dealflowRawJson as Record<string, unknown>
    expect(raw).toMatchObject({
      crmLeadId: 'lead_a', source: IMPORT_SCORING_SOURCE, importId: IMPORT, importScoredAt: response.generatedAt,
      // The calling-off banner reads the newest signal's flag.
      includeTestBuyers: true,
    })
    expect(raw.buyers).toEqual([buyer])
    expect(JSON.stringify(raw)).not.toMatch(/phone|email|5550100/i)
  })

  it("never carries a DealFlow batch time or run id (the upload's time would mark older unscored people as looked at)", () => {
    const raw = signalRow(ranked, response, IMPORT)!.dealflowRawJson as Record<string, unknown>
    expect('generatedAt' in raw).toBe(false)
    expect('generationRunId' in raw).toBe(false)
    expect(raw.queueRank).toBeNull()
    expect(IMPORT_SCORING_SOURCE).toBe('import-scoring')
  })

  it('an unranked seller gets none, as the morning sync keeps no signal for a seller missing from the call list', () => {
    expect(signalRow(unranked, response, IMPORT)).toBeNull()
  })
})
