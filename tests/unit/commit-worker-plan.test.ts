import { describe, it, expect } from 'vitest'
import { buildRowPlan, resolveMapping, type ResolvedMapping } from '@/lib/core-data/importer/commit-worker'
import type { ColumnMapping } from '@/lib/core-data/importer/ai-mapping'

const mapping: ColumnMapping[] = [
  { column: 'Name', sampleValues: [], target: { kind: 'standard_field', field: 'Contact.name' }, confidence: 1, reasoning: '' },
  { column: 'Title', sampleValues: [], target: { kind: 'standard_field', field: 'Contact.title' }, confidence: 1, reasoning: '' },
  { column: 'Addr', sampleValues: [], target: { kind: 'standard_field', field: 'Lead.primaryAddressFull' }, confidence: 1, reasoning: '' },
  { column: 'Status', sampleValues: [], target: { kind: 'standard_field', field: 'Lead.statusLabel' }, confidence: 1, reasoning: '' },
  { column: 'MojoID', sampleValues: [], target: { kind: 'standard_field', field: 'Lead.mojoId' }, confidence: 1, reasoning: '' },
  { column: 'Phone', sampleValues: [], target: { kind: 'standard_field', field: 'ContactPhone.phone' }, confidence: 1, reasoning: '' },
  { column: 'Phone2', sampleValues: [], target: { kind: 'standard_field', field: 'ContactPhone.phone' }, confidence: 1, reasoning: '' },
  { column: 'Type', sampleValues: [], target: { kind: 'standard_field', field: 'ContactPhone.type' }, confidence: 1, reasoning: '' },
  { column: 'Email', sampleValues: [], target: { kind: 'standard_field', field: 'ContactEmail.email' }, confidence: 1, reasoning: '' },
  { column: 'Junk', sampleValues: [], target: { kind: 'ignore' }, confidence: 0.2, reasoning: '' },
]

const resolved = resolveMapping(mapping, [{ column: 'Score', definitionId: 'cf_1', type: 'number' }])

describe('resolveMapping', () => {
  it('routes standard fields into slots', () => {
    expect(resolved.contactName).toBe('Name')
    expect(resolved.contactTitle).toBe('Title')
    expect(resolved.leadAddress).toBe('Addr')
    expect(resolved.leadStatus).toBe('Status')
    expect(resolved.leadMojoId).toBe('MojoID')
    expect(resolved.phoneColumns).toEqual(['Phone', 'Phone2'])
    expect(resolved.phoneTypeColumn).toBe('Type')
    expect(resolved.emailColumns).toEqual(['Email'])
    expect(resolved.customColumns).toEqual([{ column: 'Score', definitionId: 'cf_1', type: 'number' }])
  })
})

describe('buildRowPlan', () => {
  it('full row → normalized phones/emails/custom values + dedup on phone', () => {
    const plan = buildRowPlan(
      {
        Name: 'Jane Owner', Title: 'Owner', Addr: '5 Main St, NY', Status: 'Hot', MojoID: 'M1',
        Phone: '(212) 555-0134', Phone2: '212-555-0134', Type: 'Cell', Email: 'JANE@X.COM', Score: '2500000', Junk: 'x',
      },
      resolved
    )
    expect(plan.displayName).toBe('Jane Owner')
    expect(plan.lead.mojoId).toBe('M1')
    expect(plan.lead.primaryAddressFull).toBe('5 Main St, NY')
    // Duplicate phone (same E.164) collapses to one.
    expect(plan.phones).toHaveLength(1)
    expect(plan.phones[0]).toEqual({ phoneE164: '+12125550134', type: 'mobile', nonstandard: false })
    expect(plan.emails).toEqual(['jane@x.com'])
    expect(plan.customValues).toEqual([{ definitionId: 'cf_1', type: 'number', raw: '2500000' }])
    expect(plan.dedup.kind).toBe('phone')
  })

  it('nonstandard phone type is flagged', () => {
    const plan = buildRowPlan({ Name: 'X', Phone: '2125550100', Type: 'Fax' }, resolved)
    expect(plan.phones[0].nonstandard).toBe(true)
    expect(plan.phones[0].type).toBe('fax')
  })

  it('no contact/lead name → displayName falls back to address, then mojoId', () => {
    const addrOnly = buildRowPlan({ Addr: '9 Elm Ave' }, resolved)
    expect(addrOnly.displayName).toBe('9 Elm Ave')
    const mojoOnly = buildRowPlan({ MojoID: 'M9' }, resolved)
    expect(mojoOnly.displayName).toBe('M9')
    const empty = buildRowPlan({}, resolved)
    expect(empty.displayName).toBe('Imported Lead')
  })

  it('drops invalid phones and non-email values', () => {
    const plan = buildRowPlan({ Name: 'Y', Phone: 'not-a-phone', Email: 'notanemail' }, resolved)
    expect(plan.phones).toHaveLength(0)
    expect(plan.emails).toHaveLength(0)
    // No phone → dedup falls back to name-address.
    expect(plan.dedup.kind).toBe('name-address')
  })

  it('empty mapping slots produce an all-undefined lead', () => {
    const bare: ResolvedMapping = { phoneColumns: [], emailColumns: [], customColumns: [] }
    const plan = buildRowPlan({ Anything: 'z' }, bare)
    expect(plan.lead).toEqual({ name: undefined, primaryAddressFull: undefined, mojoId: undefined, statusLabel: undefined })
    expect(plan.displayName).toBe('Imported Lead')
  })
})
