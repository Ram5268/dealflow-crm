import { createHmac, timingSafeEqual } from 'node:crypto'
import { requireTwilioConfig, type TwilioConfig } from './config'

/**
 * Twilio Programmable Messaging over raw REST (brief §M4). We use fetch to a
 * configurable `apiBase` (the Twilio mock in isolation, api.twilio.com in prod)
 * rather than the SDK — fully mockable, no extra dependency, and the send is a
 * single form POST. Sends go through the Messaging Service (10DLC campaign).
 */
export interface SendSmsInput {
  to: string
  body: string
  statusCallback?: string
}

export async function sendSms(
  input: SendSmsInput,
  cfg: TwilioConfig = requireTwilioConfig(),
): Promise<{ sid: string; status: string }> {
  const url = `${cfg.apiBase}/2010-04-01/Accounts/${cfg.accountSid}/Messages.json`
  const form = new URLSearchParams()
  form.set('To', input.to)
  form.set('MessagingServiceSid', cfg.messagingServiceSid)
  form.set('Body', input.body)
  if (input.statusCallback) form.set('StatusCallback', input.statusCallback)

  const auth = Buffer.from(`${cfg.accountSid}:${cfg.authToken}`).toString('base64')
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      authorization: `Basic ${auth}`,
      'content-type': 'application/x-www-form-urlencoded',
    },
    body: form.toString(),
  })
  if (!res.ok) throw new Error(`twilio send failed: HTTP ${res.status}`)
  const data = (await res.json()) as { sid: string; status: string }
  return { sid: data.sid, status: data.status }
}

/**
 * Twilio inbound-webhook signature: HMAC-SHA1 over the full URL followed by each
 * POST param appended in lexicographic key order, base64.
 */
export function computeTwilioSignature(
  authToken: string,
  url: string,
  params: Record<string, string>,
): string {
  let data = url
  for (const key of Object.keys(params).sort()) data += key + params[key]
  return createHmac('sha1', authToken).update(Buffer.from(data, 'utf8')).digest('base64')
}

export function verifyTwilioSignature(
  authToken: string,
  url: string,
  params: Record<string, string>,
  signature: string | null | undefined,
): boolean {
  if (!signature) return false
  const expected = computeTwilioSignature(authToken, url, params)
  const a = Buffer.from(signature)
  const b = Buffer.from(expected)
  return a.length === b.length && timingSafeEqual(a, b)
}
