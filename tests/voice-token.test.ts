import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { buildVoiceToken } from "@/lib/telephony/twilio/voiceToken";

function decodeJwtPayload(jwt: string): Record<string, unknown> {
  const [, payload] = jwt.split(".");
  return JSON.parse(Buffer.from(payload, "base64").toString("utf8"));
}

describe("buildVoiceToken", () => {
  const saved = { ...process.env };
  beforeAll(() => {
    process.env.TWILIO_ACCOUNT_SID = "AC00000000000000000000000000000000";
    process.env.TWILIO_API_KEY_SID = "SK00000000000000000000000000000000";
    process.env.TWILIO_API_KEY_SECRET = "test_secret";
    process.env.TWILIO_APP_SID = "AP00000000000000000000000000000000";
  });
  afterAll(() => {
    process.env.TWILIO_ACCOUNT_SID = saved.TWILIO_ACCOUNT_SID;
    process.env.TWILIO_API_KEY_SID = saved.TWILIO_API_KEY_SID;
    process.env.TWILIO_API_KEY_SECRET = saved.TWILIO_API_KEY_SECRET;
    process.env.TWILIO_APP_SID = saved.TWILIO_APP_SID;
  });

  it("mints a JWT with a voice grant + identity and correct expiry", () => {
    const now = 1_760_000_000_000; // fixed for deterministic expiry
    const result = buildVoiceToken({ identity: "user_ryan", ttlSec: 3600, now });
    expect(result.identity).toBe("user_ryan");
    expect(result.expiresAt).toBe(new Date(now + 3600 * 1000).toISOString());

    const payload = decodeJwtPayload(result.token) as {
      grants: { identity: string; voice: { outgoing?: { application_sid?: string }; incoming?: { allow?: boolean } } };
    };
    expect(payload.grants.identity).toBe("user_ryan");
    expect(payload.grants.voice).toBeDefined();
    expect(payload.grants.voice.incoming?.allow).toBe(true);
    expect(payload.grants.voice.outgoing?.application_sid).toBe("AP00000000000000000000000000000000");
  });

  it("throws when API key creds are missing", () => {
    delete process.env.TWILIO_API_KEY_SID;
    expect(() => buildVoiceToken({ identity: "user_ryan" })).toThrow(/TWILIO_API_KEY_SID/);
    process.env.TWILIO_API_KEY_SID = "SK00000000000000000000000000000000";
  });
});
