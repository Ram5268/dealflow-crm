import twilio from "twilio";

const AccessToken = twilio.jwt.AccessToken;
const VoiceGrant = AccessToken.VoiceGrant;

export interface VoiceTokenResult {
  token: string;
  identity: string;
  expiresAt: string; // ISO8601 UTC
}

/**
 * Mint a short-lived Twilio Voice SDK access token for the browser softphone.
 * Signed with the API Key (SID/secret), grants outbound via the TwiML App and
 * allows inbound to `identity`. Default TTL 1 hour (§8.1).
 */
export function buildVoiceToken(args: { identity: string; ttlSec?: number; now?: number }): VoiceTokenResult {
  const { identity } = args;
  const ttlSec = args.ttlSec ?? 3600;
  const accountSid = process.env.TWILIO_ACCOUNT_SID;
  const apiKeySid = process.env.TWILIO_API_KEY_SID;
  const apiKeySecret = process.env.TWILIO_API_KEY_SECRET;
  const appSid = process.env.TWILIO_APP_SID;
  if (!accountSid || !apiKeySid || !apiKeySecret) {
    throw new Error(
      "TWILIO_ACCOUNT_SID / TWILIO_API_KEY_SID / TWILIO_API_KEY_SECRET required to mint a Voice token.",
    );
  }

  const token = new AccessToken(accountSid, apiKeySid, apiKeySecret, { identity, ttl: ttlSec });
  token.addGrant(new VoiceGrant({ outgoingApplicationSid: appSid, incomingAllow: true }));

  const nowMs = args.now ?? Date.now();
  return {
    token: token.toJwt(),
    identity,
    expiresAt: new Date(nowMs + ttlSec * 1000).toISOString(),
  };
}
