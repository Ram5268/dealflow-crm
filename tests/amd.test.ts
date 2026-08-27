import { describe, it, expect } from "vitest";
import { parseAmd } from "@/lib/telephony/twilio/amd";

describe("parseAmd", () => {
  it("human → bridge, amdResult human", () => {
    const r = parseAmd("human");
    expect(r).toMatchObject({ amdResult: "human", bridge: true });
    expect(r.vmDisposition).toBeUndefined();
  });

  it("unknown → bridge (fail-safe for the callee), amdResult unknown", () => {
    expect(parseAmd("unknown")).toMatchObject({ amdResult: "unknown", bridge: true });
  });

  it("missing AnsweredBy → treated as unknown → bridge", () => {
    expect(parseAmd(undefined)).toMatchObject({ amdResult: "unknown", bridge: true, raw: "unknown" });
    expect(parseAmd(null)).toMatchObject({ amdResult: "unknown", bridge: true });
  });

  it("all machine_* variants → no bridge, vm-answer", () => {
    for (const v of [
      "machine_start",
      "machine_end_beep",
      "machine_end_silence",
      "machine_end_other",
    ]) {
      expect(parseAmd(v)).toMatchObject({
        amdResult: "machine",
        bridge: false,
        vmDisposition: "vm-answer",
      });
    }
  });

  it("fax → treated as machine", () => {
    expect(parseAmd("fax")).toMatchObject({ amdResult: "machine", bridge: false, vmDisposition: "vm-answer" });
  });

  it("an unrecognized value → bridge (never silently drop a possible human)", () => {
    expect(parseAmd("weird_new_value")).toMatchObject({ amdResult: "unknown", bridge: true });
  });
});
