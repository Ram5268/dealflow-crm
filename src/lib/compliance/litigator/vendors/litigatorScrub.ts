import type { LitigatorVendorClient } from '@/lib/compliance/litigator/vendors/types'
import { VendorError } from '@/lib/compliance/errors'

// Unchosen vendor — fail-closed if selected without an implementation.
export const litigatorScrubLitigatorVendor: LitigatorVendorClient = {
  name: 'litigator_scrub',
  batchSize: 500,
  rateLimitPerSec: 5,
  async scrubBatch(): Promise<never> {
    throw new VendorError('vendor_error_litigator', 'litigator_scrub', { detail: 'not implemented; fail-closed' })
  },
}
