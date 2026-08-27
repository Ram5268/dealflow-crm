import type { LitigatorVendorClient, LitigatorVendorResult } from '@/lib/compliance/litigator/vendors/types'

// Deterministic mock litigator vendor. A phone is a litigator iff it appears in
// the set; everything else is clean.
export function makeMockLitigatorVendor(litigators: Set<string> = DEFAULT_LITIGATORS): LitigatorVendorClient {
  return {
    name: 'mock',
    batchSize: 250,
    rateLimitPerSec: 20,
    async scrubBatch(phones: string[]): Promise<LitigatorVendorResult> {
      return {
        perPhone: phones.map((phone) =>
          litigators.has(phone)
            ? { phone, isLitigator: true, vendorMatchId: `mock_${phone}` }
            : { phone, isLitigator: false }
        ),
        checkedAt: new Date().toISOString(),
      }
    },
  }
}

export const DEFAULT_LITIGATORS = new Set<string>(['+18885550000'])

export const mockLitigatorVendor: LitigatorVendorClient = makeMockLitigatorVendor()
