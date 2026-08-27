import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import type { PrismaClient } from "@prisma/client";
import { prismaPerf, listenCrmCall, type CrmCallListener } from "./setup/pg";
import { runReconciliation, type TwilioRestLike } from "@/lib/telephony/reconciliation/job";

const ORG = "org_recon";
const P = "CA_recon_";
let prisma: PrismaClient;
let listener: CrmCallListener;

function mockTwilio(over: Partial<TwilioRestLike> = {}): TwilioRestLike {
  return {
    fetchCall: async () => ({ status: "completed", duration: "42", price: "-0.0130" }),
    listCalls: async () => [],
    cancelCall: async () => {},
    ...over,
  };
}

async function seedCall(sid: string, status: string, ageMin: number, extra: Record<string, unknown> = {}) {
  return prisma.call.create({
    data: {
      organizationId: ORG,
      direction: "outbound",
      callMethod: "power",
      localPhone: "+15555550100",
      remotePhone: "+15555550101",
      providerCallSid: sid,
      source: "dealflow-crm",
      status,
      dateCreated: new Date(Date.now() - ageMin * 60 * 1000),
      ...extra,
    },
  });
}

beforeAll(async () => {
  prisma = prismaPerf(6);
  await prisma.$connect();
  listener = await listenCrmCall();
});
beforeEach(async () => {
  await prisma.call.deleteMany({ where: { providerCallSid: { startsWith: P } } });
});
afterAll(async () => {
  await prisma.call.deleteMany({ where: { providerCallSid: { startsWith: P } } });
  await listener.close();
  await prisma.$disconnect();
});

describe("runReconciliation", () => {
  it("A: converges a stuck call from Twilio truth and emits call.completed", async () => {
    const call = await seedCall(`${P}stuck`, "in-progress", 10);
    const r = await runReconciliation(prisma, { twilio: mockTwilio() });
    expect(r.converged).toBe(1);

    const updated = await prisma.call.findUnique({ where: { id: call.id } });
    expect(updated?.status).toBe("completed");
    expect(updated?.emittedAt).not.toBeNull();
    expect(Number(updated?.cost)).toBeCloseTo(0.013, 5);

    const evt = await listener.waitFor((e) => e.callId === call.id && e.type === "call.completed");
    expect(evt.disposition).toBe("answered");
    expect(typeof evt.cost).toBe("string");
  });

  it("C: re-emits call.completed for a terminal call with emittedAt null, once", async () => {
    const call = await seedCall(`${P}lost`, "completed", 5, { disposition: "answered", duration: 30 });
    const r1 = await runReconciliation(prisma, { twilio: mockTwilio() });
    expect(r1.reEmitted).toBeGreaterThanOrEqual(1);
    const evt = await listener.waitFor((e) => e.callId === call.id && e.type === "call.completed");
    expect(evt.disposition).toBe("answered");

    const after = await prisma.call.findUnique({ where: { id: call.id } });
    expect(after?.emittedAt).not.toBeNull();

    // Second run does not re-emit (emittedAt guard).
    const before = listener.events.filter((e) => e.callId === call.id).length;
    const r2 = await runReconciliation(prisma, { twilio: mockTwilio() });
    expect(r2.reEmitted).toBe(0);
    expect(listener.events.filter((e) => e.callId === call.id).length).toBe(before);
  });

  it("B: cancels an orphan Twilio call not in our DB", async () => {
    const cancelCall = vi.fn().mockResolvedValue(undefined);
    const twilio = mockTwilio({
      listCalls: async () => [{ sid: `${P}orphan_not_in_db` }],
      cancelCall,
    });
    const r = await runReconciliation(prisma, { twilio });
    expect(cancelCall).toHaveBeenCalledWith(`${P}orphan_not_in_db`);
    expect(r.orphansCanceled).toBe(1);
  });

  it("Twilio down: skips A/B but still runs C (lost-emission)", async () => {
    await seedCall(`${P}stuck2`, "in-progress", 10);
    const lost = await seedCall(`${P}lost2`, "busy", 5);
    const twilio = mockTwilio({
      fetchCall: async () => {
        throw new Error("twilio 503");
      },
    });
    const r = await runReconciliation(prisma, { twilio });
    expect(r.twilioDown).toBe(true);
    expect(r.converged).toBe(0);
    expect(r.reEmitted).toBeGreaterThanOrEqual(1);
    const after = await prisma.call.findUnique({ where: { id: lost.id } });
    expect(after?.emittedAt).not.toBeNull();
  });
});
