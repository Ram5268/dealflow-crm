import { describe, it, expect } from "vitest";
import {
  mapTwilioStatus,
  isTerminalLocalStatus,
} from "@/lib/telephony/twilio/statusMap";
import { toEventDisposition } from "@/lib/telephony/twilio/statusWebhook";

describe("mapTwilioStatus", () => {
  it("maps canceled → cancel (the reconciliation mapping)", () => {
    expect(mapTwilioStatus("canceled")).toBe("cancel");
  });

  it("maps the common Twilio statuses", () => {
    expect(mapTwilioStatus("completed")).toBe("completed");
    expect(mapTwilioStatus("busy")).toBe("busy");
    expect(mapTwilioStatus("no-answer")).toBe("no-answer");
    expect(mapTwilioStatus("failed")).toBe("failed");
    expect(mapTwilioStatus("in-progress")).toBe("in-progress");
    expect(mapTwilioStatus("ringing")).toBe("in-progress");
    expect(mapTwilioStatus("queued")).toBe("created");
    expect(mapTwilioStatus("initiated")).toBe("created");
  });

  it("returns null and logs for an unknown status", () => {
    expect(mapTwilioStatus("teleported")).toBeNull();
  });
});

describe("isTerminalLocalStatus", () => {
  it("treats completed/no-answer/busy/failed/cancel as terminal", () => {
    for (const s of ["completed", "no-answer", "busy", "failed", "cancel"] as const) {
      expect(isTerminalLocalStatus(s)).toBe(true);
    }
  });
  it("treats created/in-progress as non-terminal", () => {
    expect(isTerminalLocalStatus("created")).toBe(false);
    expect(isTerminalLocalStatus("in-progress")).toBe(false);
  });
});

describe("toEventDisposition", () => {
  it("prefers an existing valid disposition (AMD/race already decided)", () => {
    expect(toEventDisposition("completed", "vm-answer")).toBe("vm-answer");
    expect(toEventDisposition("completed", "abandoned")).toBe("abandoned");
    expect(toEventDisposition("completed", "answered")).toBe("answered");
  });

  it("derives from terminal status when no existing disposition", () => {
    expect(toEventDisposition("completed", null)).toBe("answered");
    expect(toEventDisposition("busy", null)).toBe("busy");
    expect(toEventDisposition("failed", null)).toBe("error");
    expect(toEventDisposition("cancel", null)).toBe("error");
    // §13 S4 (planner-blessed): no-answer maps to explicit `no-answer`.
    expect(toEventDisposition("no-answer", null)).toBe("no-answer");
  });

  it("ignores an invalid existing disposition and derives instead", () => {
    expect(toEventDisposition("completed", "bogus")).toBe("answered");
  });

  it("maps timeout and any other status to error (default branch)", () => {
    expect(toEventDisposition("timeout", null)).toBe("error");
    // Unexpected value exercises the switch default.
    expect(toEventDisposition("created" as never, null)).toBe("error");
  });
});
