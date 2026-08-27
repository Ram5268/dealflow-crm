import type { DncVendorClient } from '@/lib/compliance/dnc/vendors/types'
import { getEnv } from '@/lib/compliance/env'
import { noopDncVendor } from '@/lib/compliance/dnc/vendors/noop'
import { mockDncVendor } from '@/lib/compliance/dnc/vendors/mock'
import { makeTcpaShieldDncVendor } from '@/lib/compliance/dnc/vendors/tcpaShield'
import { possiblenowDncVendor } from '@/lib/compliance/dnc/vendors/possiblenow'
import { contactCenterComplianceDncVendor } from '@/lib/compliance/dnc/vendors/contactCenterCompliance'
import { dncComDncVendor } from '@/lib/compliance/dnc/vendors/dncCom'

// Vendor factory keyed by DNC_VENDOR. Unknown/missing → noop (fail-closed
// sentinel), NOT a clean pass. Normalizes punctuation so "tcpa_shield",
// "tcpashield", "TCPA Shield", "dnc.com" all resolve.
export function getDncVendor(vendorId: string | undefined = getEnv().DNC_VENDOR): DncVendorClient {
  switch ((vendorId ?? '').toLowerCase().replace(/[^a-z0-9]/g, '')) {
    case 'tcpashield':
      return makeTcpaShieldDncVendor()
    case 'mock':
      return mockDncVendor
    case 'possiblenow':
      return possiblenowDncVendor
    case 'contactcentercompliance':
      return contactCenterComplianceDncVendor
    case 'dnccom':
      return dncComDncVendor
    default:
      return noopDncVendor
  }
}
