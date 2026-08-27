import { validateRequest } from "twilio";
import { logger } from "@/lib/logger";

/**
 * Validate a Twilio webhook signature. EVERY webhook route wraps its handler in
 * this and 403s on failure — we never process an unsigned/forged webhook.
 *
 * `url` must be the FULL public URL Twilio was configured to hit (scheme + host
 * + path + query), and `params` the parsed form-encoded body. The auth token is
 * the account's — the same secret Twilio signed with.
 */
export function isValidTwilioSignature(
  authToken: string,
  signature: string | null | undefined,
  url: string,
  params: Record<string, string>,
): boolean {
  if (!signature) return false;
  try {
    return validateRequest(authToken, signature, url, params);
  } catch (err) {
    logger.warn({ err }, "Twilio signature validation threw — treating as invalid");
    return false;
  }
}

/**
 * Convenience for route handlers: reads the token from env and the signature
 * from the `x-twilio-signature` header. Returns true iff valid.
 */
export function verifyTwilioWebhook(
  signatureHeader: string | null | undefined,
  url: string,
  params: Record<string, string>,
  authToken: string | undefined = process.env.TWILIO_AUTH_TOKEN,
): boolean {
  if (!authToken) {
    logger.error("TWILIO_AUTH_TOKEN not set — cannot verify webhook signature");
    return false;
  }
  return isValidTwilioSignature(authToken, signatureHeader, url, params);
}
