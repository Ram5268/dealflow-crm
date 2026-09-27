/**
 * Brief 37 — the test-phase calling switch. The CRM leads are real homeowners
 * and DealFlow's rankings still come from test buyers, so no call may be placed
 * until Ryan turns calling on. On only when DIALING_ENABLED is exactly 'true';
 * unset (the default) means OFF. Every outbound call path checks it: placeCall
 * refuses before touching Twilio, and the call routes answer 403.
 */

export function dialingEnabled(env: Record<string, string | undefined> = process.env): boolean {
  return env.DIALING_ENABLED === 'true'
}

export const DIALING_DISABLED = {
  error: 'dialing_disabled',
  message: 'Calling is off (DIALING_ENABLED is not true). No call was placed.',
} as const

export class DialingDisabledError extends Error {
  readonly code = DIALING_DISABLED.error
  constructor() {
    super(DIALING_DISABLED.message)
    this.name = 'DialingDisabledError'
  }
}

/** The 403 every call route returns while calling is off. */
export function dialingDisabledResponse(): Response {
  return Response.json(DIALING_DISABLED, { status: 403 })
}
