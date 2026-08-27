import type { LitigatorVendorClient, LitigatorVendorResult, LitigatorVendorMatch } from '@/lib/compliance/litigator/vendors/types'
import { VendorError } from '@/lib/compliance/errors'
import { getEnv } from '@/lib/compliance/env'

// TCPA Shield litigator scrub (Ryan's selected vendor — same API/auth/bill as
// the DNC path). ⚠️ PROVISIONAL WIRE SHAPE — confirm against real docs at live
// wiring. Every non-2xx → fail-closed vendor_error_litigator.

const TIMEOUT_MS = 10_000
const DEFAULT_BASE = 'https://api.tcpashield.com' // PROVISIONAL
type FetchImpl = typeof fetch

export function makeTcpaShieldLitigatorVendor(opts: { apiKey?: string; baseUrl?: string; fetchImpl?: FetchImpl } = {}): LitigatorVendorClient {
  const apiKey = opts.apiKey ?? getEnv().LITIGATOR_API_KEY ?? ''
  const baseUrl = opts.baseUrl ?? process.env.TCPA_SHIELD_BASE_URL ?? DEFAULT_BASE
  const doFetch: FetchImpl = opts.fetchImpl ?? fetch

  return {
    name: 'tcpa_shield',
    batchSize: 250,
    rateLimitPerSec: 5,
    async scrubBatch(phones: string[], o: { correlationId: string }): Promise<LitigatorVendorResult> {
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), TIMEOUT_MS)
      let res: Response
      try {
        res = await doFetch(`${baseUrl}/v1/litigator/scrub`, {
          method: 'POST',
          headers: {
            authorization: `Bearer ${apiKey}`,
            'content-type': 'application/json',
            'x-correlation-id': o.correlationId,
          },
          body: JSON.stringify({ phones }), // PROVISIONAL
          signal: controller.signal,
        })
      } catch (err) {
        throw new VendorError('vendor_error_litigator', 'tcpa_shield', { error: String(err) })
      } finally {
        clearTimeout(timer)
      }

      if (!res.ok) throw new VendorError('vendor_error_litigator', 'tcpa_shield', { status: res.status })

      let body: any
      try {
        body = await res.json()
      } catch (err) {
        throw new VendorError('vendor_error_litigator', 'tcpa_shield', { error: 'malformed_json', detail: String(err) })
      }
      return { perPhone: parseTcpaShieldLitigator(body), checkedAt: new Date().toISOString() }
    },
  }
}

// PROVISIONAL parser. Expected: { results: [{ phone, litigator: boolean, matchId? }] }
export function parseTcpaShieldLitigator(body: any): LitigatorVendorMatch[] {
  const results = Array.isArray(body?.results) ? body.results : []
  return results.map((r: any): LitigatorVendorMatch => ({
    phone: String(r?.phone ?? ''),
    isLitigator: Boolean(r?.litigator),
    vendorMatchId: r?.matchId,
  }))
}
