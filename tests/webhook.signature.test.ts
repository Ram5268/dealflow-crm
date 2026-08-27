import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { getExpectedTwilioSignature } from "twilio";
import {
  isValidTwilioSignature,
  verifyTwilioWebhook,
} from "@/lib/telephony/twilio/signature";
import { POST as voicePOST } from "@/app/api/telephony/webhook/voice/route";

const AUTH = "test_auth_token_abc123";
const BASE = "https://crm.example.com/api/telephony/webhook";

function signedRequest(path: string, params: Record<string, string>, sig?: string): Request {
  const url = `${BASE}${path}`;
  const signature = sig ?? getExpectedTwilioSignature(AUTH, url, params);
  return new Request(url, {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      "x-twilio-signature": signature,
    },
    body: new URLSearchParams(params).toString(),
  });
}

describe("isValidTwilioSignature (pure)", () => {
  const url = `${BASE}/status`;
  const params = { CallSid: "CA_sig_1", CallStatus: "completed" };

  it("accepts a correctly-signed request", () => {
    const sig = getExpectedTwilioSignature(AUTH, url, params);
    expect(isValidTwilioSignature(AUTH, sig, url, params)).toBe(true);
  });

  it("rejects a forged signature", () => {
    expect(isValidTwilioSignature(AUTH, "forged", url, params)).toBe(false);
  });

  it("rejects a missing signature", () => {
    expect(isValidTwilioSignature(AUTH, null, url, params)).toBe(false);
    expect(isValidTwilioSignature(AUTH, undefined, url, params)).toBe(false);
  });

  it("verifyTwilioWebhook returns false when no auth token is available", () => {
    expect(verifyTwilioWebhook("anything", url, params, undefined)).toBe(false);
  });
});

describe("voice webhook route — signature gate", () => {
  beforeAll(() => {
    process.env.TWILIO_AUTH_TOKEN = AUTH;
    process.env.TWILIO_VOICE_WEBHOOK_BASE = BASE;
  });
  afterAll(() => {
    delete process.env.TWILIO_AUTH_TOKEN;
    delete process.env.TWILIO_VOICE_WEBHOOK_BASE;
  });

  it("403s on an invalid signature (no DB touched)", async () => {
    const req = signedRequest("/voice", { CallSid: "CA_route_1" }, "bad-signature");
    const res = await voicePOST(req);
    expect(res.status).toBe(403);
  });

  it("valid signature + no AnsweredBy → 200 Pause TwiML (first POST, pre-AMD)", async () => {
    const req = signedRequest("/voice", { CallSid: "CA_route_2" });
    const res = await voicePOST(req);
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain("<Pause");
  });
});
