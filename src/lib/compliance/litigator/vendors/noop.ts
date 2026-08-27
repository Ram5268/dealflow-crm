import type { LitigatorVendorClient } from '@/lib/compliance/litigator/vendors/types'
import { VendorError } from '@/lib/compliance/errors'

// Fail-closed sentinel for an unset/unknown LITIGATOR_VENDOR. Throws so the
// check layer fails-closed with vendor_error_not_configured.
export const noopLitigatorVendor: LitigatorVendorClient = {
  name: 'noop',
  batchSize: 1,
  rateLimitPerSec: 1,
  async scrubBatch(): Promise<never> {
    throw new VendorError('vendor_error_not_configured', 'noop', {
      detail: 'LITIGATOR_VENDOR is not configured; failing closed.',
    })
  },
}
