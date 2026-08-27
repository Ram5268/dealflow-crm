/**
 * Health report for `/api/comms/health` (brief §9). Fast + dependency-light: it
 * reports configuration presence, not live round-trips to Gmail/Graph/Twilio, so
 * the check can't hang and the isolation-boot smoke is deterministic. `status` is
 * `degraded` only when a HARD requirement (encryption key, DB) is missing —
 * booting without token encryption is refused elsewhere; here we surface it.
 */
export interface HealthReport {
  status: 'ok' | 'degraded'
  checks: {
    databaseConfigured: boolean
    encryptionKeyPresent: boolean
    gmailConfigured: boolean
    graphConfigured: boolean
    twilioConfigured: boolean
    smsEnabled: boolean
  }
}

export function healthReport(
  env: Record<string, string | undefined> = process.env,
): HealthReport {
  const checks = {
    databaseConfigured: Boolean(env.DATABASE_URL_MAIN),
    encryptionKeyPresent: Boolean(env.OAUTH_TOKEN_ENCRYPTION_KEY),
    gmailConfigured: Boolean(env.GOOGLE_CLIENT_ID),
    graphConfigured: Boolean(env.MSFT_GRAPH_CLIENT_ID),
    twilioConfigured: Boolean(env.TWILIO_MESSAGING_SERVICE_SID),
    smsEnabled: env.SMS_ENABLED === 'true',
  }
  const status: HealthReport['status'] =
    checks.databaseConfigured && checks.encryptionKeyPresent ? 'ok' : 'degraded'
  return { status, checks }
}
