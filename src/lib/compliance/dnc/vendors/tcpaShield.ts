import type { DncVendorClient, DncVendorResult, DncVendorMatch } from '@/lib/compliance/dnc/vendors/types'
import { VendorError } from '@/lib/compliance/errors'
import { getEnv } from '@/lib/compliance/env'

// TCPA Shield — federal + state DNC (Ryan's selected vendor). Bundles both under
// one API/auth/bill.
//
// ⚠️ PROVISIONAL WIRE SHAPE. The exact endpoint, auth header, request body, and
// response fields below are placeholders to be CONFIRMED against TCPA Shield's
// real API docs at live wiring (keys arrive mid-M2). The pipeline + tests run
// against the mock vendor, so this file's contract is exercised only for its
// parsing + fail-closed behavior (unit test with a fake fetch). Until the real
// semantics are documented, EVERY non-2xx is a vendor error → fail-closed
// (§2a). See tcpaShield.status-codes.ts.

const TIMEOUT_MS = 10_000
const DEFAULT_BASE = 'https://api.tcpashield.com' // PROVISIONAL

type FetchImpl = typeof fetch

export function makeTcpaShieldDncVendor(opts: { apiKey?: string; baseUrl?: string; fetchImpl?: FetchImpl } = {}): DncVendorClient {
  const apiKey = opts.apiKey ?? getEnv().DNC_API_KEY ?? ''
  const baseUrl = opts.baseUrl ?? process.env.TCPA_SHIELD_BASE_URL ?? DEFAULT_BASE
  const doFetch: FetchImpl = opts.fetchImpl ?? fetch

  return {
    name: 'tcpa_shield',
    batchSize: 250,
    rateLimitPerSec: 5,
    async scrubBatch(phones: string[], o: { correlationId: string }): Promise<DncVendorResult> {
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), TIMEOUT_MS)
      let res: Response
      try {
        res = await doFetch(`${baseUrl}/v1/dnc/scrub`, {
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
        // Timeout / network error → fail-closed.
        throw new VendorError('vendor_error_dnc', 'tcpa_shield', { error: String(err) })
      } finally {
        clearTimeout(timer)
      }

      if (!res.ok) {
        throw new VendorError('vendor_error_dnc', 'tcpa_shield', { status: res.status })
      }

      let body: any
      try {
        body = await res.json()
      } catch (err) {
        throw new VendorError('vendor_error_dnc', 'tcpa_shield', { error: 'malformed_json', detail: String(err) })
      }

      return { perPhone: parseTcpaShieldDnc(body), checkedAt: new Date().toISOString() }
    },
  }
}

// PROVISIONAL response parser. Expected shape (to confirm):
//   { results: [{ phone, dnc: boolean, listType?: 'federal'|'state', state?: 'NY' }] }
export function parseTcpaShieldDnc(body: any): DncVendorMatch[] {
  const results = Array.isArray(body?.results) ? body.results : []
  return results.map((r: any): DncVendorMatch => {
    const onList = Boolean(r?.dnc)
    let list = ''
    if (onList) {
      list = r?.listType === 'state' && r?.state ? `state:${String(r.state).toUpperCase()}` : 'federal'
    }
    return { phone: String(r?.phone ?? ''), onList, list, vendorMatchId: r?.matchId }
  })
}
