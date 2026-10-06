import { describe, it, expect } from 'vitest'
import { mappingKey, resumePoint } from '@/lib/core-data/importer/batch'
import type { MappingProposal } from '@/lib/core-data/importer/ai-mapping'

// Brief 41 (M25): a stopped import continues on a re-run only with the same
// mapping. "Back to the import" asks the AI again, so the fingerprint must not
// change with its wording, samples, confidence or custom-field targets.
const proposal = (mapping: unknown[]) => ({ mapping, likelyDuplicates: [] }) as unknown as MappingProposal
const std = (column: string, field: string, reasoning = '', confidence = 1, sampleValues: string[] = []) =>
  ({ column, sampleValues, target: { kind: 'standard_field', field }, confidence, reasoning })

describe('mappingKey', () => {
  const base = proposal([
    std('Phone', 'ContactPhone.phone', 'A phone column.', 0.98, ['212-555-0100']),
    std('Owner', 'Lead.name', 'Names.', 0.9, ['Ann']),
    { column: 'Notes', sampleValues: ['x'], target: { kind: 'new_custom_field', name: 'Notes', type: 'text' }, confidence: 0.6, reasoning: 'Free text.' },
  ])

  it('ignores wording, samples, confidence, column order and custom-field targets', () => {
    const again = proposal([
      { column: 'Notes', sampleValues: ['y'], target: { kind: 'existing_custom_field', definitionId: 'cfd_1' }, confidence: 0.9, reasoning: 'Existing field.' },
      std('Owner', 'Lead.name', 'Owner names.', 0.8, ['Bob']),
      std('Phone', 'ContactPhone.phone', 'Phones.', 0.7, ['212-555-0199']),
    ])
    expect(mappingKey(again)).toBe(mappingKey(base))
    const notesIgnored = proposal([std('Phone', 'ContactPhone.phone'), std('Owner', 'Lead.name'), { column: 'Notes', sampleValues: [], target: { kind: 'ignore' }, confidence: 1, reasoning: '' }])
    expect(mappingKey(notesIgnored)).toBe(mappingKey(base))
  })

  it('changes when a column feeds a different standard field, or one is added or dropped', () => {
    expect(mappingKey(proposal([std('Phone', 'ContactPhone.phone'), std('Owner', 'Contact.name')]))).not.toBe(mappingKey(base))
    expect(mappingKey(proposal([std('Phone', 'ContactPhone.phone')]))).not.toBe(mappingKey(base))
    expect(mappingKey(proposal([std('Phone', 'ContactPhone.phone'), std('Owner', 'Lead.name'), std('Addr', 'Lead.primaryAddressFull')]))).not.toBe(mappingKey(base))
  })
})

describe('resumePoint', () => {
  const key = mappingKey(proposal([std('Phone', 'ContactPhone.phone')]))
  const stop = (resume: unknown, mappingKey = key) => [{ row: 5, message: 'bad cell' }, { row: 0, message: 'Import stopped: time limit…', resume, mappingKey }]

  it('reads the recorded point for the same mapping only', () => {
    expect(resumePoint(stop({ next: 3, partial: [[1, 2]] }), key)).toEqual({ next: 3, partial: [[1, 2]] })
    expect(resumePoint(stop({ next: 3, partial: [] }, 'other'), key)).toBeNull()
  })

  it('ignores anything malformed or empty', () => {
    for (const bad of [undefined, null, {}, { next: 0, partial: [] }, { next: -1, partial: [] }, { next: 2.5, partial: [] }, { next: 2 }, { next: 2, partial: [[1]] }, { next: 2, partial: [[1, -1]] }, { next: 2, partial: 'x' }]) {
      expect(resumePoint(stop(bad), key)).toBeNull()
    }
    expect(resumePoint(null, key)).toBeNull()
    expect(resumePoint([{ row: 3, message: 'x' }], key)).toBeNull()
  })
})
