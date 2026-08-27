import { describe, it, expect } from 'vitest'
import { z } from 'zod'
import queueContract from '../http/queue.json'
import complianceContract from '../http/compliance-callable-now.json'
import type { QueueResponse } from '../../src/lib/core-data/smart-view/queue-service'

// Gate 2 HTTP shapes. Validates the frozen OpenAPI docs enforce the locked
// field names AND that A's own response type conforms.

describe('queue.json contract', () => {
  const queueLead = queueContract.components.schemas.QueueLead
  const queueResp = queueContract.components.schemas.QueueResponse

  it('QueueLead requires primaryPhoneE164 (renamed from primaryPhone)', () => {
    expect(queueLead.required).toContain('primaryPhoneE164')
    expect(queueLead.required).toContain('contactId')
    expect(queueLead.required).toContain('leadId')
    expect(queueLead.properties).not.toHaveProperty('primaryPhone')
  })

  it('QueueResponse carries the additive exclusion + stale fields', () => {
    expect(queueResp.required).toEqual(expect.arrayContaining(['view', 'leads', 'generatedAt']))
    for (const k of ['stale', 'staleReason', 'excludedNoPhone', 'excludedCompliance']) {
      expect(queueResp.properties).toHaveProperty(k)
    }
  })
})

describe('compliance-callable-now.json contract', () => {
  const schemas = complianceContract.components.schemas

  it('request caps contactPhoneIds at 100', () => {
    expect(schemas.CallableNowRequest.properties.contactPhoneIds.maxItems).toBe(100)
  })
  it('result carries contactPhoneId + phone + callable + reasons', () => {
    expect(schemas.CallableNowResult.required).toEqual(
      expect.arrayContaining(['contactPhoneId', 'phone', 'callable', 'reasons'])
    )
  })
})

// A's own queue response type conforms to the contract (non-null guarantees).
const queueLeadZod = z.object({
  leadId: z.string(),
  contactId: z.string(),
  primaryPhoneId: z.string(),
  primaryPhoneE164: z.string(),
  displayName: z.string(),
  timezone: z.string(),
  primaryAddressSummary: z.string().nullable(),
  ammunition: z.object({
    priorityScore: z.number().nullable(),
    topMatchFit: z.number().nullable(),
    captureStatus: z.string().nullable(),
    matchReason: z.string().nullable(),
    dealflowDeepLink: z.string().nullable(),
  }),
})

describe('queue-service output conforms to contract', () => {
  it('a representative QueueResponse validates + has no primaryPhone field', () => {
    const sample: QueueResponse = {
      view: { id: 'save_1', name: 'Hot Buyers' },
      leads: [
        {
          leadId: 'l1',
          contactId: 'ct1',
          primaryPhoneId: 'ph1',
          primaryPhoneE164: '+12125551234',
          displayName: 'Acme LLC',
          primaryAddressSummary: '5 Main St',
          timezone: 'America/New_York',
          ammunition: { priorityScore: 90, topMatchFit: 88, captureStatus: 'OWN_BUYER_ONLY', matchReason: 'fit', dealflowDeepLink: 'https://x/1' },
        },
      ],
      excludedNoPhone: 2,
      excludedCompliance: 1,
      generatedAt: '2026-08-27T00:00:00.000Z',
      stale: false,
    }
    for (const l of sample.leads) {
      expect(() => queueLeadZod.parse(l)).not.toThrow()
      expect(l).not.toHaveProperty('primaryPhone')
    }
  })
})
