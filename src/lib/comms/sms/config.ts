/**
 * SMS enablement + Twilio/10DLC config (brief M1/M4, Ryan's constraints).
 *
 * SMS_ENABLED=false (the default) means every SMS code path compiles and
 * unit-tests with mocks but NEVER touches real Twilio. Flipping to true is a
 * RUNTIME config change, not a code change. When enabled, the 10DLC SIDs are
 * required — the send worker calls `requireTwilioConfig()` and fails fast with a
 * clear reason if they're missing (unregistered A2P SMS has been blocked since
 * Feb 2025).
 */

export function smsEnabled(env: Record<string, string | undefined> = process.env): boolean {
  return env.SMS_ENABLED === 'true'
}

export class SmsDisabledError extends Error {
  readonly code = 'sms_pending_10dlc'
  constructor() {
    super('SMS is disabled (SMS_ENABLED=false) — pending 10DLC approval.')
    this.name = 'SmsDisabledError'
  }
}

export interface TwilioConfig {
  accountSid: string
  authToken: string
  messagingServiceSid: string
  brandId: string
  campaignId: string
  apiBase: string
}

/**
 * Resolve + validate Twilio/10DLC config. Only meaningful when SMS is enabled.
 * Throws (fail-fast) listing every missing var so the operator knows exactly
 * what 10DLC artifact hasn't landed yet.
 */
export function requireTwilioConfig(
  env: Record<string, string | undefined> = process.env,
): TwilioConfig {
  const accountSid = env.TWILIO_ACCOUNT_SID ?? ''
  const authToken = env.TWILIO_AUTH_TOKEN ?? ''
  const messagingServiceSid = env.TWILIO_MESSAGING_SERVICE_SID ?? ''
  const brandId = env.TWILIO_10DLC_BRAND_ID ?? ''
  const campaignId = env.TWILIO_10DLC_CAMPAIGN_ID ?? ''

  const missing: string[] = []
  if (!accountSid) missing.push('TWILIO_ACCOUNT_SID')
  if (!authToken) missing.push('TWILIO_AUTH_TOKEN')
  if (!messagingServiceSid) missing.push('TWILIO_MESSAGING_SERVICE_SID')
  if (!brandId) missing.push('TWILIO_10DLC_BRAND_ID')
  if (!campaignId) missing.push('TWILIO_10DLC_CAMPAIGN_ID')

  if (missing.length > 0) {
    throw new Error(
      `SMS_ENABLED=true but 10DLC/Twilio config is incomplete: missing ${missing.join(', ')}. ` +
        'SMS stays parked until the 10DLC campaign is approved and SIDs are set.',
    )
  }

  return {
    accountSid,
    authToken,
    messagingServiceSid,
    brandId,
    campaignId,
    apiBase: env.TWILIO_API_BASE ?? 'https://api.twilio.com',
  }
}
