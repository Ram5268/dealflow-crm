import { describe, it, expect, afterEach } from "vitest";
import { twilioClient, __resetTwilioClient } from "@/lib/telephony/twilio/client";

describe("twilioClient", () => {
  const saved = {
    sid: process.env.TWILIO_ACCOUNT_SID,
    token: process.env.TWILIO_AUTH_TOKEN,
  };

  afterEach(() => {
    __resetTwilioClient();
    if (saved.sid === undefined) delete process.env.TWILIO_ACCOUNT_SID;
    else process.env.TWILIO_ACCOUNT_SID = saved.sid;
    if (saved.token === undefined) delete process.env.TWILIO_AUTH_TOKEN;
    else process.env.TWILIO_AUTH_TOKEN = saved.token;
  });

  it("throws when creds are absent", () => {
    delete process.env.TWILIO_ACCOUNT_SID;
    delete process.env.TWILIO_AUTH_TOKEN;
    __resetTwilioClient();
    expect(() => twilioClient()).toThrow(/TWILIO_ACCOUNT_SID/);
  });

  it("constructs and memoizes a client when creds are present", () => {
    // Twilio requires an ACxxxx-shaped SID; a test value is fine (no network).
    process.env.TWILIO_ACCOUNT_SID = "AC00000000000000000000000000000000";
    process.env.TWILIO_AUTH_TOKEN = "test_token";
    __resetTwilioClient();
    const a = twilioClient();
    const b = twilioClient();
    expect(a).toBe(b); // memoized singleton
  });
});
