import type { DncVendorClient } from '@/lib/compliance/dnc/vendors/types'
import { VendorError } from '@/lib/compliance/errors'

// Unchosen vendor — fail-closed if selected without an implementation.
export const dncComDncVendor: DncVendorClient = {
  name: 'dnc_com',
  batchSize: 500,
  rateLimitPerSec: 5,
  async scrubBatch(): Promise<never> {
    throw new VendorError('vendor_error_dnc', 'dnc_com', { detail: 'not implemented; fail-closed' })
  },
}
