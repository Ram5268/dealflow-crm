import { VendorError } from '@/lib/compliance/errors'
import { getEnv } from '@/lib/compliance/env'

// Twilio Lookup v2 line-type intelligence. The ONLY Twilio API this slice
// touches (no Voice/Messaging). Advisory-only: a failure here NEVER flips
// callable (see mobileLine/check.ts) — it throws, and the caller swallows it.

export interface LineTypeResult {
  lineType: string // mobile|landline|voip|unknown
  carrier?: string
}

type FetchImpl = typeof fetch
const BASE = 'https://lookups.twilio.com/v2/PhoneNumbers'

export async function twilioLineLookup(
  phone: string,
  opts: { accountSid?: string; authToken?: string; fetchImpl?: FetchImpl } = {}
): Promise<LineTypeResult> {
  const env = getEnv()
  const sid = opts.accountSid ?? env.TWILIO_ACCOUNT_SID ?? ''
  const token = opts.authToken ?? env.TWILIO_AUTH_TOKEN ?? ''
  const doFetch: FetchImpl = opts.fetchImpl ?? fetch

  const auth = Buffer.from(`${sid}:${token}`).toString('base64')
  let res: Response
  try {
    res = await doFetch(`${BASE}/${encodeURIComponent(phone)}?Fields=line_type_intelligence`, {
      headers: { authorization: `Basic ${auth}` },
    })
  } catch (err) {
    throw new VendorError('vendor_error_mobile_line', 'twilio_lookup', { error: String(err) })
  }
  if (!res.ok) throw new VendorError('vendor_error_mobile_line', 'twilio_lookup', { status: res.status })

  let body: any
  try {
    body = await res.json()
  } catch (err) {
    throw new VendorError('vendor_error_mobile_line', 'twilio_lookup', { error: 'malformed_json', detail: String(err) })
  }
  const lti = body?.line_type_intelligence ?? {}
  return { lineType: String(lti.type ?? 'unknown'), carrier: lti.carrier_name ?? undefined }
}
