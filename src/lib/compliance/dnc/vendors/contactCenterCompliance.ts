import type { DncVendorClient } from '@/lib/compliance/dnc/vendors/types'
import { VendorError } from '@/lib/compliance/errors'

// Unchosen vendor — fail-closed if selected without an implementation.
export const contactCenterComplianceDncVendor: DncVendorClient = {
  name: 'contact_center_compliance',
  batchSize: 500,
  rateLimitPerSec: 5,
  async scrubBatch(): Promise<never> {
    throw new VendorError('vendor_error_dnc', 'contact_center_compliance', { detail: 'not implemented; fail-closed' })
  },
}
