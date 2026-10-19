import { describe, it, expect } from 'vitest'
import { mappingTargetSchema, type ColumnMapping, type MappingTarget } from '@/lib/core-data/importer/ai-mapping'
import {
  FIELD_LABELS,
  FIELD_ORDER,
  IGNORE_LABEL,
  NOTHING_TO_MATCH,
  checkMapping,
  choiceValue,
  columnChoices,
  matchingKey,
  setColumnTarget,
  targetForChoice,
} from '@/lib/core-data/importer/mapping-edit'

// Brief 50 PR 6 (open item 6.6; audit L23/L5): Ryan can change each column's
// mapping on the review screen, including "Don't import", before committing.
// These are the pure pieces behind the screen's dropdowns and its checks.

const col = (column: string, target: MappingTarget, confidence = 0.9): ColumnMapping => ({
  column, sampleValues: [], target, confidence, reasoning: '',
})
const std = (field: string) => ({ kind: 'standard_field', field }) as MappingTarget
const IGNORE: MappingTarget = { kind: 'ignore' }
const customFields = [
  { definitionId: 'cf_est', name: 'Estimated Value', type: 'number' },
  { definitionId: 'cf_list', name: 'Dialer List', type: 'text' },
]

describe('the field choices', () => {
  it('cover every standard field the commit understands, each with a plain-English label', () => {
    for (const field of FIELD_ORDER) {
      expect(mappingTargetSchema.safeParse({ kind: 'standard_field', field }).success).toBe(true)
      expect(FIELD_LABELS[field]).toMatch(/^[A-Z]/)
    }
    // Nothing the schema accepts is missing from the dropdown.
    const shape = mappingTargetSchema.options[0].shape.field.options
    expect([...FIELD_ORDER].sort()).toEqual([...shape].sort())
  })

  it("a column's dropdown: Don't import, the main fields, a new custom field, then the existing custom fields", () => {
    const groups = columnChoices('Est Value', { kind: 'new_custom_field', name: 'Est. Value', type: 'number' }, customFields)
    const values = groups.flatMap((g) => g.options.map((o) => o.value))
    const labels = groups.flatMap((g) => g.options.map((o) => o.label))
    expect(values[0]).toBe('ignore')
    expect(labels[0]).toBe(IGNORE_LABEL)
    expect(labels).toContain('Owner name')
    expect(labels).toContain('Mojo ID')
    expect(labels).toContain('Phone')
    expect(labels).toContain('New custom field "Est. Value"')
    expect(labels).toContain('Custom field: Estimated Value')
    expect(groups.map((g) => g.label)).toEqual([null, 'Main fields', 'Custom fields'])
  })

  it('a new custom field takes the name the AI proposed, or else the column header', () => {
    expect(targetForChoice('new', 'Est Value', { kind: 'new_custom_field', name: 'Est. Value', type: 'number', choices: [] }, customFields))
      .toEqual({ kind: 'new_custom_field', name: 'Est. Value', type: 'number', choices: [] })
    expect(targetForChoice('new', ' Owner Notes ', IGNORE, customFields)).toEqual({ kind: 'new_custom_field', name: 'Owner Notes', type: 'text' })
  })

  it('no "new custom field" when one with that name already exists: the existing one is offered instead', () => {
    const labels = columnChoices('Estimated Value', IGNORE, customFields).flatMap((g) => g.options.map((o) => o.label))
    expect(labels).not.toContain('New custom field "Estimated Value"')
    expect(labels).toContain('Custom field: Estimated Value')
  })

  it('each choice round-trips through the dropdown value', () => {
    const targets: MappingTarget[] = [IGNORE, std('Lead.mojoId'), std('ContactPhone.phone'), { kind: 'existing_custom_field', definitionId: 'cf_est' }]
    for (const t of targets) expect(targetForChoice(choiceValue(t), 'X', IGNORE, customFields)).toEqual(t)
    expect(choiceValue({ kind: 'new_custom_field', name: 'Anything', type: 'text' })).toBe('new')
  })

  it('a value the dropdown never offers is refused, not guessed', () => {
    expect(() => targetForChoice('std:Lead.secret', 'X', IGNORE, customFields)).toThrow()
    expect(() => targetForChoice('cf:nope', 'X', IGNORE, customFields)).toThrow()
  })

  it("changing one column touches only that column, and the AI's confidence no longer applies to it", () => {
    const mapping = [col('Contact ID', { kind: 'new_custom_field', name: 'Contact ID', type: 'text' }), col('Phone', std('ContactPhone.phone'))]
    const next = setColumnTarget(mapping, 'Contact ID', std('Lead.mojoId'))
    expect(next[0]).toMatchObject({ column: 'Contact ID', target: std('Lead.mojoId') })
    expect(next[1]).toBe(mapping[1])
    expect(mapping[0].target.kind).toBe('new_custom_field') // not mutated
  })
})

describe('checkMapping: what stops a commit, and what only warns', () => {
  it('nothing to match a row on (no Mojo ID, phone, name or address) blocks the commit', () => {
    const { problems } = checkMapping([col('Notes', IGNORE), col('Est', { kind: 'existing_custom_field', definitionId: 'cf_est' })], customFields)
    expect(problems).toEqual([NOTHING_TO_MATCH])
    expect(NOTHING_TO_MATCH).toMatch(/Mojo ID, a phone, a name or the property address/)
  })

  it('any one of them is enough', () => {
    for (const field of ['Lead.mojoId', 'ContactPhone.phone', 'Lead.name', 'Contact.name', 'Lead.primaryAddressFull']) {
      expect(checkMapping([col('A', std(field))]).problems).toEqual([])
    }
    expect(checkMapping([col('A', std('Lead.statusLabel'))]).problems).toEqual([NOTHING_TO_MATCH])
  })

  it('one custom field fed by two columns blocks the commit (the second would clash with the first)', () => {
    const { problems } = checkMapping(
      [
        col('Phone', std('ContactPhone.phone')),
        col('Est 1', { kind: 'existing_custom_field', definitionId: 'cf_est' }),
        col('Est 2', { kind: 'new_custom_field', name: 'Estimated Value', type: 'number' }),
      ],
      customFields,
    )
    expect(problems).toEqual(['"Estimated Value" is chosen for 2 columns (Est 1 and Est 2). Choose it for one column only.'])
  })

  it('a one-value field chosen for two columns only warns: the commit uses the last of them, as it always has', () => {
    const { problems, warnings } = checkMapping([col('First', std('Lead.name')), col('Last', std('Lead.name')), col('Phone', std('ContactPhone.phone'))])
    expect(problems).toEqual([])
    expect(warnings).toEqual(['"Owner name" is chosen for 2 columns (First and Last). Only the last one, Last, is imported.'])
  })

  it('phones and emails may come from several columns', () => {
    const r = checkMapping([col('Phone 1', std('ContactPhone.phone')), col('Phone 2', std('ContactPhone.phone')), col('E1', std('ContactEmail.email')), col('E2', std('ContactEmail.email'))])
    expect(r).toEqual({ problems: [], warnings: [] })
  })
})

describe('matchingKey: when the "already in your CRM" check must run again', () => {
  const base = [col('ID', std('Lead.mojoId')), col('Phone', std('ContactPhone.phone')), col('Est', { kind: 'new_custom_field', name: 'Est', type: 'number' })]
  it('changes when a column that decides matching changes', () => {
    expect(matchingKey(setColumnTarget(base, 'ID', IGNORE))).not.toBe(matchingKey(base))
    expect(matchingKey(setColumnTarget(base, 'Est', std('Lead.primaryAddressFull')))).not.toBe(matchingKey(base))
  })
  it("doesn't change for a custom field, a status or the AI's wording", () => {
    expect(matchingKey(setColumnTarget(base, 'Est', IGNORE))).toBe(matchingKey(base))
    expect(matchingKey([...base, col('Status', std('Lead.statusLabel'))])).toBe(matchingKey(base))
    expect(matchingKey(base.map((c) => ({ ...c, reasoning: 'other words', confidence: 0.1 })))).toBe(matchingKey(base))
  })
})
