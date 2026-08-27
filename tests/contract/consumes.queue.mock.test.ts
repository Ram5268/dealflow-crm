import { describe, it, expect, afterEach } from "vitest";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { createQueueServer } from "../../contracts/mocks/queueServer";
import { getQueue } from "@/lib/telephony/dial-loop/queueClient";
import { eligibleLeads } from "@/lib/telephony/dial-loop/nextContact";
import { prismaPerf } from "../setup/pg";

let server: Server | undefined;
async function startQueue(opts?: Parameters<typeof createQueueServer>[0]): Promise<string> {
  server = createQueueServer(opts);
  await new Promise<void>((r) => server!.listen(0, r));
  return `http://localhost:${(server!.address() as AddressInfo).port}`;
}
afterEach(async () => {
  if (server) await new Promise<void>((r) => server!.close(() => r()));
  server = undefined;
});

describe("consumes GET /api/queue (mock is faithful to the contract)", () => {
  it("parses primaryPhoneE164 + passthrough fields; does not crash on stale/timezone-null", async () => {
    const base = await startQueue({ stale: true, timezoneNullFirst: true, count: 2 });
    const q = await getQueue({ baseUrl: base }, "save_mocktest");
    expect(q.leads[0].primaryPhoneE164).toMatch(/^\+1/);
    expect(q.leads[0].primaryPhoneId).toBe("cph_0");
    expect(q.leads[0].timezone).toBeNull(); // tolerated, not synthesized
    expect(q.stale).toBe(true);
    // Passthrough telemetry fields survive the parse.
    expect((q as unknown as { excludedNoPhone: number }).excludedNoPhone).toBe(0);
  });

  it("eligibleLeads accepts the mock shape and keeps leads with primaryPhoneId", async () => {
    const base = await startQueue({ count: 3 });
    const q = await getQueue({ baseUrl: base }, "save_mocktest");
    const prisma = prismaPerf(2);
    await prisma.$connect();
    try {
      const eligible = await eligibleLeads(prisma, q.leads);
      expect(eligible).toHaveLength(3); // none are recent dropped-losers
      expect(eligible.every((l) => l.primaryPhoneId)).toBe(true);
    } finally {
      await prisma.$disconnect();
    }
  });
});
