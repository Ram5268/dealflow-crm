import { describe, it, expect } from 'vitest'
import {
  MAPPING_SYSTEM_PROMPT,
  buildRetryPrompt,
  mappingProposalSchema,
  proposeMapping,
  repairMappingKinds,
} from '@/lib/core-data/importer/ai-mapping'

const parsed = {
  headerRow: ['Full Name', 'Contact ID', 'Phone', 'Phone Type', 'Estimated Value'],
  sampleRows: [['Owner 0 LLC', 'E2E_0', '+12125552000', 'Cell', '100000']],
  totalRowsDetected: 1,
} as never

/** The response the live model actually returned (M6 probe). Column 4 is a
 *  valid new-custom-field payload wearing the wrong discriminator. */
function liveResponse() {
  return {
    mapping: [
      { column: 'Full Name', sampleValues: [], confidence: 0.95, reasoning: '', target: { kind: 'standard_field', field: 'Lead.name' } },
      { column: 'Contact ID', sampleValues: [], confidence: 0.9, reasoning: '', target: { kind: 'standard_field', field: 'Lead.mojoId' } },
      { column: 'Phone', sampleValues: [], confidence: 0.95, reasoning: '', target: { kind: 'standard_field', field: 'ContactPhone.phone' } },
      { column: 'Phone Type', sampleValues: [], confidence: 0.9, reasoning: '', target: { kind: 'standard_field', field: 'ContactPhone.type' } },
      { column: 'Estimated Value', sampleValues: [], confidence: 0.8, reasoning: '', target: { kind: 'custom_field', name: 'Estimated Value', type: 'number' } },
    ],
    likelyDuplicates: [],
  }
}

describe('repairMappingKinds', () => {
  it('the exact live failure now parses, and keeps the column', () => {
    // Before M6 this threw ZodError at mapping[4].target.kind and the route
    // answered 503 — a five-column CSV could not be imported at all.
    const before = mappingProposalSchema.safeParse(liveResponse())
    expect(before.success).toBe(false)

    const { raw, coerced } = repairMappingKinds(liveResponse())
    const after = mappingProposalSchema.parse(raw)

    expect(coerced).toEqual([
      { column: 'Estimated Value', from: 'custom_field', to: 'new_custom_field' },
    ])
    // THE POINT: the column survives as a custom field. Coercing it to
    // `ignore` would have silently dropped one of Ryan's columns.
    expect(after.mapping[4].target).toEqual({
      kind: 'new_custom_field',
      name: 'Estimated Value',
      type: 'number',
    })
  })

  it('infers the variant from the payload when the alias is unknown', () => {
    const res = repairMappingKinds({
      mapping: [
        { column: 'A', sampleValues: [], confidence: 1, reasoning: '', target: { kind: 'wat', name: 'A', type: 'text' } },
        { column: 'B', sampleValues: [], confidence: 1, reasoning: '', target: { kind: 'zzz', definitionId: 'def_1' } },
        { column: 'C', sampleValues: [], confidence: 1, reasoning: '', target: { kind: 'nope', field: 'Lead.name' } },
      ],
      likelyDuplicates: [],
    })
    const parsedOut = mappingProposalSchema.parse(res.raw)
    expect(parsedOut.mapping.map((m) => m.target.kind)).toEqual([
      'new_custom_field',
      'existing_custom_field',
      'standard_field',
    ])
  })

  it('falls back to ignore only when the payload says nothing', () => {
    const res = repairMappingKinds({
      mapping: [{ column: 'Mystery', sampleValues: [], confidence: 0.1, reasoning: '', target: { kind: 'garbage' } }],
      likelyDuplicates: [],
    })
    const parsedOut = mappingProposalSchema.parse(res.raw)
    expect(parsedOut.mapping[0].target).toEqual({ kind: 'ignore' })
    expect(res.coerced[0]).toEqual({ column: 'Mystery', from: 'garbage', to: 'ignore' })
  })

  it('strips variant-specific keys when coercing to ignore', () => {
    // `ignore` is a bare object in the union; leftover keys would be harmless
    // to zod but misleading to anything reading the stored mappingJson.
    const res = repairMappingKinds({
      mapping: [{ column: 'X', sampleValues: [], confidence: 0, reasoning: '', target: { kind: '???', field: 'NotAStandardField' } }],
      likelyDuplicates: [],
    })
    expect((res.raw as never as { mapping: { target: object }[] }).mapping[0].target).toEqual({ kind: 'ignore' })
  })

  it('leaves a clean response completely untouched', () => {
    const clean = liveResponse()
    clean.mapping[4].target = { kind: 'new_custom_field', name: 'Estimated Value', type: 'number' } as never
    const res = repairMappingKinds(clean)
    expect(res.coerced).toEqual([])
    expect(mappingProposalSchema.parse(res.raw)).toBeTruthy()
  })

  it('survives malformed shapes instead of throwing', () => {
    expect(repairMappingKinds(null).coerced).toEqual([])
    expect(repairMappingKinds({ mapping: 'not-an-array' }).coerced).toEqual([])
    expect(repairMappingKinds({ mapping: [null, { target: null }, {}] }).coerced).toEqual([])
  })
})

describe('proposeMapping', () => {
  it('returns the coerced columns so the rewrite is never silent', async () => {
    const caller = async () => JSON.stringify(liveResponse())
    const out = await proposeMapping(parsed, [], caller)
    expect(out.coercedColumns).toHaveLength(1)
    expect(out.coercedColumns[0].column).toBe('Estimated Value')
    expect(out.mapping).toHaveLength(5)
  })

  it('does NOT retry when only some columns were coerced', async () => {
    let calls = 0
    const caller = async () => {
      calls++
      return JSON.stringify(liveResponse())
    }
    await proposeMapping(parsed, [], caller)
    // One bad column out of five is a good result — a second API call would
    // buy nothing on a mapping Ryan reviews by hand anyway.
    expect(calls).toBe(1)
  })

  it('retries ONCE with the error fed back when every column was coerced', async () => {
    const allBad = {
      mapping: [
        { column: 'A', sampleValues: [], confidence: 1, reasoning: '', target: { kind: 'bogus' } },
        { column: 'B', sampleValues: [], confidence: 1, reasoning: '', target: { kind: 'bogus' } },
      ],
      likelyDuplicates: [],
    }
    const good = {
      mapping: [
        { column: 'A', sampleValues: [], confidence: 1, reasoning: '', target: { kind: 'standard_field', field: 'Lead.name' } },
        { column: 'B', sampleValues: [], confidence: 1, reasoning: '', target: { kind: 'ignore' } },
      ],
      likelyDuplicates: [],
    }
    const prompts: string[] = []
    const caller = async (_system: string, user: string) => {
      prompts.push(user)
      return JSON.stringify(prompts.length === 1 ? allBad : good)
    }
    const out = await proposeMapping(parsed, [], caller)
    expect(prompts).toHaveLength(2)
    expect(prompts[1]).toContain('YOUR PREVIOUS RESPONSE WAS REJECTED')
    expect(prompts[1]).toContain('bogus')
    expect(out.coercedColumns).toEqual([])
  })

  it('keeps the coerced first response when the retry itself fails', async () => {
    let calls = 0
    const caller = async () => {
      calls++
      if (calls === 1) {
        return JSON.stringify({
          mapping: [{ column: 'A', sampleValues: [], confidence: 1, reasoning: '', target: { kind: 'bogus' } }],
          likelyDuplicates: [],
        })
      }
      throw new Error('provider down')
    }
    const out = await proposeMapping(parsed, [], caller)
    expect(calls).toBe(2)
    // Degraded, not failed: an import Ryan can still fix by hand beats a 503.
    expect(out.mapping[0].target.kind).toBe('ignore')
  })
})

describe('prompt', () => {
  it('names every discriminator literal — the omission that caused the bug', () => {
    // The old prompt spelled out kind:"ignore" but never named the other three,
    // so the model invented "custom_field" for the one column it had to guess.
    for (const kind of ['standard_field', 'new_custom_field', 'existing_custom_field', 'ignore']) {
      expect(MAPPING_SYSTEM_PROMPT).toContain(kind)
    }
  })

  it('the retry prompt carries the rejection reason', () => {
    expect(buildRetryPrompt('BASE', 'because reasons')).toContain('because reasons')
    expect(buildRetryPrompt('BASE', 'x')).toContain('BASE')
  })
})
