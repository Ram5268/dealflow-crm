// The DNC vendor client contract (§2a). A vendor scrubs a batch of E.164
// phones and reports, per phone, whether it is on a federal or state DNC list.
// Every concrete client (TCPA Shield, PossibleNOW, ...) implements this; the
// pipeline is written against the interface, never a specific vendor.
export interface DncVendorMatch {
  phone: string
  onList: boolean
  list: string // 'federal' | 'state:XX'
  vendorMatchId?: string
}

export interface DncVendorResult {
  perPhone: DncVendorMatch[]
  checkedAt: string // ISO 8601 UTC
}

export interface DncVendorClient {
  readonly name: string
  readonly batchSize: number
  readonly rateLimitPerSec: number
  scrubBatch(phones: string[], opts: { correlationId: string }): Promise<DncVendorResult>
}
