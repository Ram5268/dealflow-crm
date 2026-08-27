import twilio, { type Twilio } from "twilio";

/**
 * Twilio REST client singleton. Constructed lazily from Doppler-injected creds
 * (test credentials work fine for Milestone 2 smokes). Throws if creds absent so
 * a misconfigured deploy fails loudly rather than dialing into the void.
 */
let _client: Twilio | undefined;

export function twilioClient(): Twilio {
  if (_client) return _client;
  const accountSid = process.env.TWILIO_ACCOUNT_SID;
  const authToken = process.env.TWILIO_AUTH_TOKEN;
  if (!accountSid || !authToken) {
    throw new Error(
      "TWILIO_ACCOUNT_SID / TWILIO_AUTH_TOKEN not set — cannot construct Twilio client.",
    );
  }
  _client = twilio(accountSid, authToken);
  return _client;
}

/** Test seam: reset the memoized client (used between tests). */
export function __resetTwilioClient(): void {
  _client = undefined;
}
