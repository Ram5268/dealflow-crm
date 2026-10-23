import { describe, it, expect } from 'vitest'
import { ZodError } from 'zod'
import { mappingProposalSchema, proposeMapping, repairMappingKinds, type AnthropicCaller } from '@/lib/core-data/importer/ai-mapping'
import {
  AI_UNAVAILABLE_NOTICE,
  AI_UNREADABLE_NOTICE,
  LAST_RUN_NOTICE,
  proposalForReview,
  savedProposal,
} from '@/lib/core-data/importer/review-proposal'
import type { ParsedFile } from '@/lib/core-data/importer/parser'

// Brief 50 PR 6 (open item 6.6; audit L23/L5). The review screen used to dead-
// end: one unreadable AI answer gave "Map the columns manually to continue",
// but there was no way to map them by hand. Now:
//   - a made-up field name in one column no longer sinks the whole answer;
//   - when the AI can't be read or reached, the screen opens with every column
//     on "Don't import" and Ryan picks each field himself;
//   - "Back to the import" after a stopped run shows the mapping he committed
//     (with his own changes), not a fresh AI guess.

const parsed: ParsedFile = {
  headerRow: ['Contact ID', 'Full Name', 'Phone'],
  sampleRows: [
    { 'Contact ID': 'M_1', 'Full Name': 'Test Owner One', Phone: '212-555-0161' },
    { 'Contact ID': 'M_2', 'Full Name': '', Phone: '212-555-0162' },
  ],
  totalRowsDetected: 2,
  allRows: [],
}
const good = {
  mapping: [
    { column: 'Contact ID', sampleValues: ['M_1'], confidence: 0.9, reasoning: '', target: { kind: 'standard_field', field: 'Lead.mojoId' } },
    { column: 'Full Name', sampleValues: [], confidence: 0.9, reasoning: '', target: { kind: 'standard_field', field: 'Lead.name' } },
    { column: 'Phone', sampleValues: [], confidence: 0.9, reasoning: '', target: { kind: 'standard_field', field: 'ContactPhone.phone' } },
  ],
  likelyDuplicates: [],
}
const answer = (body: unknown): AnthropicCaller => async () => JSON.stringify(body)
const never: AnthropicCaller = async () => {
  throw new Error('the AI must not be asked here')
}

describe('a made-up field name in one column', () => {
  it('becomes "ignore" for that column, listed as rewritten, instead of failing the whole answer', async () => {
    const body = structuredClone(good)
    body.mapping[2].target = { kind: 'standard_field', field: 'Lead.phone' }
    expect(mappingProposalSchema.safeParse(body).success).toBe(false) // the old dead end
    const { coerced } = repairMappingKinds(structuredClone(body))
    expect(coerced).toEqual([{ column: 'Phone', from: 'Lead.phone', to: 'ignore' }])
    const out = await proposeMapping(parsed, [], answer(body))
    expect(out.mapping.map((m) => m.target.kind)).toEqual(['standard_field', 'standard_field', 'ignore'])
    expect(out.coercedColumns).toEqual([{ column: 'Phone', from: 'Lead.phone', to: 'ignore' }])
  })
})

describe('proposalForReview', () => {
  it("the AI's answer, when it has one", async () => {
    const out = await proposalForReview({ parsed, existing: [], caller: answer(good), saved: null })
    expect(out).toMatchObject({ source: 'ai', notice: null })
    expect(out.mapping).toHaveLength(3)
  })

  it("an unreadable AI answer: every column starts on Don't import, with real sample values, and the reason", async () => {
    const out = await proposalForReview({ parsed, existing: [], caller: answer({ nonsense: true }), saved: null })
    expect(out.source).toBe('manual')
    expect(out.notice).toBe(AI_UNREADABLE_NOTICE)
    expect(out.error).toBeInstanceOf(ZodError)
    expect(out.mapping).toEqual([
      { column: 'Contact ID', sampleValues: ['M_1', 'M_2'], target: { kind: 'ignore' }, confidence: 0, reasoning: '' },
      { column: 'Full Name', sampleValues: ['Test Owner One'], target: { kind: 'ignore' }, confidence: 0, reasoning: '' },
      { column: 'Phone', sampleValues: ['212-555-0161', '212-555-0162'], target: { kind: 'ignore' }, confidence: 0, reasoning: '' },
    ])
    expect(mappingProposalSchema.parse(out)).toBeTruthy() // committable once Ryan picks fields
  })

  it('the AI unreachable (no key, an outage): the same, with a reload hint', async () => {
    const out = await proposalForReview({ parsed, existing: [], caller: async () => { throw new Error('ANTHROPIC_API_KEY not set') }, saved: null })
    expect(out).toMatchObject({ source: 'manual', notice: AI_UNAVAILABLE_NOTICE })
    expect(out.mapping.every((m) => m.target.kind === 'ignore')).toBe(true)
  })

  it('the notices say what to do on this screen, and never point to a screen that does not exist', () => {
    for (const n of [AI_UNREADABLE_NOTICE, AI_UNAVAILABLE_NOTICE]) {
      expect(n).toMatch(/below/)
      expect(n).not.toMatch(/manually to continue/)
    }
    expect(AI_UNAVAILABLE_NOTICE).toMatch(/reload/i)
    expect(LAST_RUN_NOTICE).toMatch(/last committed/)
  })

  it('back to a stopped import: the mapping as committed (Ryan\'s changes kept), without asking the AI', async () => {
    const committed = structuredClone(good)
    committed.mapping[1].target = { kind: 'standard_field', field: 'Contact.name' } // changed by hand
    const mappingJson = { ...committed, importRun: { id: 'run_1', beatAt: '2026-10-19T12:00:00.000Z' } }
    const saved = savedProposal(mappingJson)
    expect(saved?.mapping[1].target).toEqual({ kind: 'standard_field', field: 'Contact.name' })
    const out = await proposalForReview({ parsed, existing: [], caller: never, saved })
    expect(out).toMatchObject({ source: 'last-run', notice: LAST_RUN_NOTICE, coercedColumns: [] })
    expect(out.mapping).toEqual(committed.mapping)
  })

  it('a saved mapping that no longer reads as one is ignored (the AI is asked as before)', () => {
    expect(savedProposal(null)).toBeNull()
    expect(savedProposal({ importRun: { id: 'x', beatAt: 'y' } })).toBeNull()
    expect(savedProposal({ mapping: [{ column: 'A' }], likelyDuplicates: [] })).toBeNull()
  })
})

describe('custom fields that already exist (review round 1)', () => {
  // The commit reuses a custom field by name, so a "new" field named like an
  // existing one is that field. The picker offers no "new" choice for it, so
  // left as "new" the screen showed "Don't import" for a column that is
  // imported: an AI answer on a re-upload, and every new field a stopped run
  // already made.
  const existing = [{ definitionId: 'cf_bed', name: 'Bedrooms', type: 'number' }]
  const withCustom = (target: unknown) => {
    const body = structuredClone(good) as { mapping: Array<Record<string, unknown>>; likelyDuplicates: unknown[] }
    body.mapping.push({ column: 'Beds', sampleValues: ['3'], confidence: 0.9, reasoning: '', target })
    return body
  }
  const beds = (out: { mapping: Array<{ column: string; target: unknown }> }) => out.mapping.find((m) => m.column === 'Beds')!.target

  it("the AI's new field named like an existing one shows as that field", async () => {
    const out = await proposalForReview({ parsed, existing, caller: answer(withCustom({ kind: 'new_custom_field', name: 'Bedrooms', type: 'number' })), saved: null })
    expect(beds(out)).toEqual({ kind: 'existing_custom_field', definitionId: 'cf_bed' })
    expect(out.coercedColumns).toEqual([])
  })

  it('back to a stopped import: a new field that run made shows as that field', async () => {
    const saved = savedProposal(withCustom({ kind: 'new_custom_field', name: 'Bedrooms', type: 'number' }))
    const out = await proposalForReview({ parsed, existing, caller: never, saved })
    expect(beds(out)).toEqual({ kind: 'existing_custom_field', definitionId: 'cf_bed' })
  })

  it("a custom field that doesn't exist is Don't import, flagged for a check", async () => {
    const out = await proposalForReview({ parsed, existing, caller: answer(withCustom({ kind: 'existing_custom_field', definitionId: 'cf_gone' })), saved: null })
    expect(beds(out)).toEqual({ kind: 'ignore' })
    expect(out.coercedColumns).toEqual([{ column: 'Beds', from: 'cf_gone', to: 'ignore' }])
  })
})
