import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { PrismaClient } from "@prisma/client";
import { prismaPerf, listenCrmCall, type CrmCallListener } from "../setup/pg";
import { handleStatusWebhook } from "@/lib/telephony/twilio/statusWebhook";
import { CallCompletedEvent } from "../../contracts/tests/schemas";

const ORG = "org_emit_comp";
const P = "CA_emit_comp_";
let prisma: PrismaClient;
let listener: CrmCallListener;

beforeAll(async () => {
  prisma = prismaPerf(4);
  await prisma.$connect();
  await prisma.call.deleteMany({ where: { providerCallSid: { startsWith: P } } });
  listener = await listenCrmCall();
});
afterAll(async () => {
  await prisma.call.deleteMany({ where: { providerCallSid: { startsWith: P } } });
  await prisma.activity.deleteMany({ where: { organizationId: ORG } }); // Brief 50 (PR 3): timeline entry
  await listener.close();
  await prisma.$disconnect();
});

describe("emits call.completed matching the frozen contract", () => {
  it("payload parses against CallCompletedEvent; cost is decimal-as-string", async () => {
    const call = await prisma.call.create({
      data: {
        organizationId: ORG,
        direction: "outbound",
        callMethod: "power",
        localPhone: "+15555550100",
        remotePhone: "+15555550101",
        providerCallSid: `${P}1`,
        source: "dealflow-crm",
        status: "in-progress",
      },
    });

    await handleStatusWebhook(prisma, {
      CallSid: `${P}1`,
      CallStatus: "completed",
      CallDuration: "55",
      Price: "-0.0200",
    });
    const evt = await listener.waitFor((e) => e.callId === call.id && e.type === "call.completed");

    const parsed = CallCompletedEvent.parse(evt);
    expect(parsed.type).toBe("call.completed");
    expect(parsed.disposition).toBe("answered");
    expect(parsed.duration).toBe(55);
    expect(typeof parsed.cost).toBe("string"); // NOT a number
    expect(Number(parsed.cost)).toBeCloseTo(0.02, 5);
    expect(evt).not.toHaveProperty("eventName");
  });
});
