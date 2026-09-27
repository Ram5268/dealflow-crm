import { describe, it, expect, vi, afterEach } from "vitest";
import type { PrismaClient } from "@prisma/client";
import { dialingEnabled, DialingDisabledError } from "@/lib/telephony/dialingSwitch";
import { placeCall, type TwilioCallCreator } from "@/lib/telephony/dial-loop/placeCall";
import { POST as startDialSession } from "@/app/api/telephony/dial-sessions/route";
import { POST as softphoneToken } from "@/app/api/telephony/calls/token/route";
import { POST as operatorConference } from "@/app/api/telephony/voice/conference/route";

// Brief 37 — the test-phase calling switch. Off unless DIALING_ENABLED is
// exactly 'true'; every outbound call path refuses while it is off.
const saved = process.env.DIALING_ENABLED;
afterEach(() => {
  if (saved === undefined) delete process.env.DIALING_ENABLED;
  else process.env.DIALING_ENABLED = saved;
});

const post = (path: string, body: BodyInit, type = "application/json") =>
  new Request(`https://crm.test${path}`, { method: "POST", headers: { "content-type": type }, body });

describe("dialingEnabled", () => {
  it("is on only for the exact string 'true'", () => {
    expect(dialingEnabled({ DIALING_ENABLED: "true" })).toBe(true);
    for (const v of [undefined, "", "false", "1", "TRUE", "yes", " true"]) {
      expect(dialingEnabled({ DIALING_ENABLED: v })).toBe(false);
    }
  });
});

describe("while calling is off", () => {
  it("placeCall refuses before Twilio is touched", async () => {
    delete process.env.DIALING_ENABLED;
    const create = vi.fn();
    const client = { calls: { create } } as unknown as TwilioCallCreator;
    await expect(
      placeCall({} as PrismaClient, { organizationId: "o", callMethod: "power", callerId: "+15555550100", toPhone: "+15555550101", contactPhoneId: "p" }, { client }),
    ).rejects.toBeInstanceOf(DialingDisabledError);
    expect(create).not.toHaveBeenCalled();
  });

  it.each([
    ["dial-sessions (Start power/predictive session)", () => startDialSession(post("/api/telephony/dial-sessions", JSON.stringify({ viewId: "save_default", method: "power", lineCount: 1, callerId: "+15555550100" })))],
    ["calls/token (softphone)", () => softphoneToken(post("/api/telephony/calls/token", "{}"))],
    ["voice/conference (Twilio operator bridge)", () => operatorConference(post("/api/telephony/voice/conference", "conferenceName=conf_x", "application/x-www-form-urlencoded"))],
  ])("%s answers 403 dialing_disabled", async (_name, call) => {
    delete process.env.DIALING_ENABLED;
    const res = await call();
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ error: "dialing_disabled" });
  });

  it("'false' and '1' still mean off", async () => {
    for (const v of ["false", "1"]) {
      process.env.DIALING_ENABLED = v;
      expect((await softphoneToken(post("/api/telephony/calls/token", "{}"))).status).toBe(403);
    }
  });
});

describe("with DIALING_ENABLED='true'", () => {
  it("the switch steps aside (the token route falls through to its own checks)", async () => {
    process.env.DIALING_ENABLED = "true";
    const res = await softphoneToken(post("/api/telephony/calls/token", "{}"));
    const body = await res.json();
    expect(body.error).not.toBe("dialing_disabled");
  });
});
