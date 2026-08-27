import { describe, it, expect } from 'vitest'
import { mockDncVendor } from '@/lib/compliance/dnc/vendors/mock'
import { mockLitigatorVendor } from '@/lib/compliance/litigator/vendors/mock'
import contacts from '../../mocks/compliance/fixtures/contacts.json'

// Gate 2 (direction 2) — the mocks the slice consumes are faithful. The mock
// vendors implement the real client interfaces, and the fixture rows conform to
// the shapes Agent A will really write, so the real service is a drop-in swap.
describe('mock vendors implement the client interface', () => {
  it('mockDnc has the interface fields and returns the DncVendorResult shape', async () => {
    expect(mockDncVendor).toMatchObject({ name: expect.any(String), batchSize: expect.any(Number), rateLimitPerSec: expect.any(Number) })
    const r = await mockDncVendor.scrubBatch(['+1'], { correlationId: 'c' })
    expect(r).toHaveProperty('checkedAt')
    expect(r.perPhone[0]).toMatchObject({ phone: '+1', onList: expect.any(Boolean), list: expect.any(String) })
  })

  it('mockLitigator has the interface fields and returns the LitigatorVendorResult shape', async () => {
    const r = await mockLitigatorVendor.scrubBatch(['+1'], { correlationId: 'c' })
    expect(r.perPhone[0]).toMatchObject({ phone: '+1', isLitigator: expect.any(Boolean) })
  })
})

describe('fixture rows are shaped like Agent A writes', () => {
  it('organization + contacts + phones + Lead.source import convention', () => {
    expect(contacts.organization).toMatchObject({ id: 'org_test', slug: 'dealflow-ryan' })
    for (const c of contacts.contacts) expect(c).toHaveProperty('leadId')
    for (const p of contacts.contactPhones) expect(p).toMatchObject({ id: expect.any(String), contactId: expect.any(String), phone: expect.any(String) })
    const importLead = contacts.leads.find((l: any) => l.id === 'lead_import_01')
    expect(importLead?.source).toBe('import:ib_test_01')
  })
})
