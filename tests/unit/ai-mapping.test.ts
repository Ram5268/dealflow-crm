import { describe, it, expect, vi } from 'vitest'
import {
  proposeMapping,
  buildUserPrompt,
  MAPPING_SYSTEM_PROMPT,
  MODEL_ID,
  type AnthropicCaller,
} from '@/lib/core-data/importer/ai-mapping'
import type { ParsedFile } from '@/lib/core-data/importer/parser'

const parsed: ParsedFile = {
  headerRow: ['Contact ID', 'Full Name', 'Phone', 'Est Value'],
  sampleRows: [
    { 'Contact ID': 'MJ-1001', 'Full Name': 'Acme LLC', Phone: '(212) 555-0134', 'Est Value': '$2,500,000' },
    { 'Contact ID': 'MJ-1002', 'Full Name': 'Beta Corp', Phone: '212-555-0200', 'Est Value': '$1,800,000' },
  ],
  totalRowsDetected: 2,
  allRows: [],
}

describe('ai-mapping — prompt', () => {
  it('MODEL_ID is the locked Sonnet 4.6 id', () => {
    expect(MODEL_ID).toBe('claude-sonnet-4-6')
  })
  it('user prompt includes headers, per-column samples, and existing custom fields', () => {
    const prompt = buildUserPrompt(parsed, [{ definitionId: 'cf_1', name: 'Owner Occ', type: 'text' }])
    expect(prompt).toContain('Contact ID')
    expect(prompt).toContain('MJ-1001')
    expect(prompt).toContain('cf_1')
    expect(MAPPING_SYSTEM_PROMPT).toContain('DETECT AGGRESSIVELY')
  })
})

describe('ai-mapping — proposeMapping parsing', () => {
  const aiResponse = {
    mapping: [
      {
        column: 'Contact ID',
        sampleValues: ['MJ-1001', 'MJ-1002'],
        target: { kind: 'standard_field', field: 'Lead.mojoId' },
        confidence: 0.95,
        reasoning: 'Header "Contact ID" + short alphanumeric ids → Mojo ID',
      },
      {
        column: 'Est Value',
        sampleValues: ['$2,500,000'],
        target: { kind: 'new_custom_field', name: 'Estimated Value', type: 'number' },
        confidence: 0.8,
        reasoning: 'Dollar amounts → numeric custom field',
      },
    ],
    likelyDuplicates: [],
  }

  it('parses a clean JSON response', async () => {
    const caller: AnthropicCaller = vi.fn(async () => JSON.stringify(aiResponse))
    const result = await proposeMapping(parsed, [], caller)
    expect(result.mapping).toHaveLength(2)
    expect(result.mapping[0].target).toEqual({ kind: 'standard_field', field: 'Lead.mojoId' })
    expect(caller).toHaveBeenCalledWith(MAPPING_SYSTEM_PROMPT, expect.stringContaining('Contact ID'))
  })

  it('tolerates fenced ```json blocks and leading prose', async () => {
    const caller: AnthropicCaller = async () =>
      'Here is the mapping:\n```json\n' + JSON.stringify(aiResponse) + '\n```'
    const result = await proposeMapping(parsed, [], caller)
    expect(result.mapping[0].column).toBe('Contact ID')
  })

  it('rejects a response that violates the schema', async () => {
    const bad: AnthropicCaller = async () =>
      JSON.stringify({ mapping: [{ column: 'X', target: { kind: 'bogus' } }], likelyDuplicates: [] })
    await expect(proposeMapping(parsed, [], bad)).rejects.toThrow()
  })
})
