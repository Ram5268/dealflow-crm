import type { LitigatorVendorClient } from '@/lib/compliance/litigator/vendors/types'
import { getEnv } from '@/lib/compliance/env'
import { noopLitigatorVendor } from '@/lib/compliance/litigator/vendors/noop'
import { mockLitigatorVendor } from '@/lib/compliance/litigator/vendors/mock'
import { makeTcpaShieldLitigatorVendor } from '@/lib/compliance/litigator/vendors/tcpaShield'
import { blacklistAllianceLitigatorVendor } from '@/lib/compliance/litigator/vendors/blacklistAlliance'
import { litigatorScrubLitigatorVendor } from '@/lib/compliance/litigator/vendors/litigatorScrub'

// Factory keyed by LITIGATOR_VENDOR. Unknown/missing → noop (fail-closed).
export function getLitigatorVendor(vendorId: string | undefined = getEnv().LITIGATOR_VENDOR): LitigatorVendorClient {
  switch ((vendorId ?? '').toLowerCase().replace(/[^a-z0-9]/g, '')) {
    case 'tcpashield':
      return makeTcpaShieldLitigatorVendor()
    case 'mock':
      return mockLitigatorVendor
    case 'blacklistalliance':
      return blacklistAllianceLitigatorVendor
    case 'litigatorscrub':
      return litigatorScrubLitigatorVendor
    default:
      return noopLitigatorVendor
  }
}
