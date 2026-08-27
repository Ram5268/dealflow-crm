import type { DncVendorClient, DncVendorResult } from '@/lib/compliance/dnc/vendors/types'

// Deterministic mock DNC vendor for isolation boot + tests. Faithful to the
// DncVendorClient interface so the real vendor is a drop-in swap. A phone is
// "on list" iff it appears in the blocked map; everything else scrubs clean.
export function makeMockDncVendor(blocked: Map<string, string> = DEFAULT_BLOCKED): DncVendorClient {
  return {
    name: 'mock',
    batchSize: 250,
    rateLimitPerSec: 20,
    async scrubBatch(phones: string[]): Promise<DncVendorResult> {
      return {
        perPhone: phones.map((phone) => {
          const list = blocked.get(phone)
          return list
            ? { phone, onList: true, list, vendorMatchId: `mock_${phone}` }
            : { phone, onList: false, list: '' }
        }),
        checkedAt: new Date().toISOString(),
      }
    },
  }
}

// Canned blocked numbers used by the isolation seed / smoke.
export const DEFAULT_BLOCKED = new Map<string, string>([
  ['+18005550000', 'federal'],
  ['+12125550003', 'state:NY'],
])

export const mockDncVendor: DncVendorClient = makeMockDncVendor()
