import { describe, it, expect, afterEach } from "vitest";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { createComplianceServer } from "../../contracts/mocks/complianceServer";
import { checkCallable, isCallable } from "@/lib/telephony/dial-loop/compliance";

let server: Server | undefined;
async function startCompliance(): Promise<string> {
  server = createComplianceServer();
  await new Promise<void>((r) => server!.listen(0, r));
  return `http://localhost:${(server!.address() as AddressInfo).port}`;
}
afterEach(async () => {
  if (server) await new Promise<void>((r) => server!.close(() => r()));
  server = undefined;
});

describe("consumes POST /api/compliance/callable-now (fail-closed everywhere)", () => {
  it("callable:true carries contactPhoneId + phone", async () => {
    const base = await startCompliance();
    const [r] = await checkCallable({ baseUrl: base }, ["cph_ok"]);
    expect(r.callable).toBe(true);
    expect(r.contactPhoneId).toBe("cph_ok");
    expect(r.phone).toBe("+15555550000");
  });

  it("callable:false with a REASON_CODES reason", async () => {
    const base = await startCompliance();
    const res = await isCallable({ baseUrl: base }, "cph_dnc");
    expect(res.callable).toBe(false);
    expect(res.reasons).toContain("internal_dnc");
  });

  it("timeout / unreachable → fail-closed (all callable:false)", async () => {
    // No server started → connection refused → fail-closed.
    const res = await checkCallable(
      { baseUrl: "http://localhost:1", timeoutMs: 500 },
      ["cph_a", "cph_b"],
    );
    expect(res.every((r) => !r.callable)).toBe(true);
    expect(res).toHaveLength(2);
  });

  it("response missing `phone` → fail-closed (schema drift)", async () => {
    const base = await startCompliance();
    const res = await isCallable({ baseUrl: base }, "cph_nophone");
    expect(res.callable).toBe(false); // whole response fails safeParse → fail-closed
  });

  it("unknown reason value → still honored fail-closed", async () => {
    const base = await startCompliance();
    const res = await isCallable({ baseUrl: base }, "cph_unkreason");
    expect(res.callable).toBe(false);
  });

  it("mock enforces the 100-id cap with HTTP 413", async () => {
    const base = await startCompliance();
    const ids = Array.from({ length: 101 }, (_, i) => `cph_${i}`);
    const res = await fetch(`${base}/api/compliance/callable-now`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ contactPhoneIds: ids }),
    });
    expect(res.status).toBe(413);
  });
});
