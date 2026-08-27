// The litigator vendor client contract (§2d), mirroring DncVendorClient. Reports
// per phone whether the number belongs to a known TCPA litigator.
export interface LitigatorVendorMatch {
  phone: string
  isLitigator: boolean
  vendorMatchId?: string
}

export interface LitigatorVendorResult {
  perPhone: LitigatorVendorMatch[]
  checkedAt: string // ISO 8601 UTC
}

export interface LitigatorVendorClient {
  readonly name: string
  readonly batchSize: number
  readonly rateLimitPerSec: number
  scrubBatch(phones: string[], opts: { correlationId: string }): Promise<LitigatorVendorResult>
}
