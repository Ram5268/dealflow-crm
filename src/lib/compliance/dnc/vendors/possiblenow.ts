import type { DncVendorClient } from '@/lib/compliance/dnc/vendors/types'
import { VendorError } from '@/lib/compliance/errors'

// Unchosen vendor. File exists so the factory can reference it; selecting it
// without a real implementation fails-closed (never a silent clean pass).
export const possiblenowDncVendor: DncVendorClient = {
  name: 'possiblenow',
  batchSize: 500,
  rateLimitPerSec: 5,
  async scrubBatch(): Promise<never> {
    throw new VendorError('vendor_error_dnc', 'possiblenow', { detail: 'not implemented; fail-closed' })
  },
}
