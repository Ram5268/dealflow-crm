import { describe, it, expect } from 'vitest'
import { buildPerfRows, PERF_TOTAL_LEADS } from '../../scripts/seed-dev'
import { PERF_QUERIES } from '../../scripts/perf-25k'

// Brief 50 (6.14): the 25,000-lead speed test now seeds its own data
// (tests/perf/25k.test.ts). That data is made up: fictional streets, and phone
// numbers only in the fictional 555-0100..0199 range (they repeat; that's fine).
describe('the 25k speed-test seed (scripts/seed-dev.ts)', () => {
  const rows = buildPerfRows()

  it('has 25,000 leads with ~25k contacts, ~33k phones and 50k custom values', () => {
    expect(PERF_TOTAL_LEADS).toBe(25_000)
    expect(rows.leads).toHaveLength(25_000)
    expect(rows.contacts.length).toBeGreaterThan(24_000)
    expect(rows.phones.length).toBeGreaterThan(30_000)
    expect(rows.values).toHaveLength(50_000)
  })

  it('uses fictional phones (555-0100..0199 only) and fictional streets', () => {
    for (const p of rows.phones) expect(p.phone).toMatch(/^\+121255501\d\d$/)
    for (const l of rows.leads) {
      expect(l.primaryAddressSummary).toMatch(/^\d+ Example St$/)
      expect(l.primaryAddressFull).toMatch(/^\d+ Example St, New York, NY \d+$/)
    }
    // Each contact's phones are distinct (ContactPhone is unique per contact + phone).
    const pairs = new Set(rows.phones.map((p) => `${p.contactId} ${p.phone}`))
    expect(pairs.size).toBe(rows.phones.length)
  })

  it('keeps the shapes the 20 speed-test queries look for', () => {
    expect(PERF_QUERIES).toHaveLength(20)
    expect(rows.leads.some((l) => l.displayName.includes('Lead 1'))).toBe(true)
    expect(rows.leads.some((l) => l.mojoId === 'mojo_1000')).toBe(true)
    expect(rows.leads.some((l) => l.source?.startsWith('import:'))).toBe(true)
    expect(new Set(rows.leads.map((l) => l.captureStatus))).toEqual(
      new Set(['EXTERNAL_BOTH', 'OWN_BUYER_ONLY', 'OWN_LISTING_ONLY', 'OWN_BOTH_SIDES']),
    )
    expect(rows.contacts.some((c) => c.title === 'Owner')).toBe(true)
    expect(rows.phones.some((p) => p.type === 'mobile')).toBe(true)
    expect(rows.values.some((v) => v.definitionId === 'cf_seed_1' && v.valueText?.startsWith('note 5'))).toBe(true)
    expect(rows.values.some((v) => v.definitionId === 'cf_seed_0' && (v.valueNumber ?? 0) >= 1_000_000)).toBe(true)
  })
})
