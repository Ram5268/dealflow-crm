import type { DncVendorClient } from '@/lib/compliance/dnc/vendors/types'
import { VendorError } from '@/lib/compliance/errors'

// Fail-closed sentinel used when DNC_VENDOR is unset/unknown. It does NOT return
// a clean pass — it THROWS, so the check layer's uniform try/catch turns the
// batch into callable:false with reason `vendor_error_not_configured`. This is
// the "no vendor configured => block everything" guarantee.
export const noopDncVendor: DncVendorClient = {
  name: 'noop',
  batchSize: 1,
  rateLimitPerSec: 1,
  async scrubBatch(): Promise<never> {
    throw new VendorError('vendor_error_not_configured', 'noop', {
      detail: 'DNC_VENDOR is not configured; failing closed.',
    })
  },
}
