import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { PrismaClient } from "@prisma/client";
import { prismaPerf } from "./setup/pg";
import { placeCall, type TwilioCallCreator } from "@/lib/telephony/dial-loop/placeCall";

const CALL_PREFIX = "CA_place_";
const ORG = "org_place_1";
let prisma: PrismaClient;

beforeAll(async () => {
  prisma = prismaPerf(4);
  await prisma.$connect();
  await prisma.call.deleteMany({ where: { providerCallSid: { startsWith: CALL_PREFIX } } });
  await prisma.pacingMetric.deleteMany({ where: { organizationId: ORG } });
});

afterAll(async () => {
  await prisma.call.deleteMany({ where: { providerCallSid: { startsWith: CALL_PREFIX } } });
  await prisma.pacingMetric.deleteMany({ where: { organizationId: ORG } });
  await prisma?.$disconnect();
});

describe("placeCall", () => {
  it("calls Twilio with async-AMD params, then inserts Call+leg with source dealflow-crm", async () => {
    let captured: Record<string, unknown> | undefined;
    const mockClient: TwilioCallCreator = {
      calls: {
        create: async (opts) => {
          captured = opts;
          return { sid: `${CALL_PREFIX}1` };
        },
      },
    };

    const res = await placeCall(
      prisma,
      {
        organizationId: ORG,
        callMethod: "power",
        callerId: "+15555550100",
        toPhone: "+15555550199",
        contactPhoneId: "cph_place_1",
        dialSessionId: null,
        ringTimeoutSec: 19,
      },
      { client: mockClient, webhookBase: "https://crm.example.com/api/telephony/webhook" },
    );

    // Twilio call params.
    expect(captured?.to).toBe("+15555550199");
    expect(captured?.from).toBe("+15555550100");
    expect(captured?.machineDetection).toBe("DetectMessageEnd");
    expect(captured?.asyncAmd).toBe("true");
    expect(captured?.timeout).toBe(19);
    expect(captured?.url).toBe("https://crm.example.com/api/telephony/webhook/voice");
    expect(captured?.statusCallback).toBe("https://crm.example.com/api/telephony/webhook/status");

    // DB state.
    const call = await prisma.call.findUnique({ where: { providerCallSid: `${CALL_PREFIX}1` } });
    expect(call?.id).toBe(res.callId);
    expect(call?.source).toBe("dealflow-crm"); // NOT "Close.io"
    expect(call?.status).toBe("created");
    expect(call?.direction).toBe("outbound");

    const leg = await prisma.callLeg.findFirst({ where: { providerLegSid: `${CALL_PREFIX}1` } });
    expect(leg?.contactPhoneId).toBe("cph_place_1");

    const agg = await prisma.pacingMetric.aggregate({
      where: { organizationId: ORG },
      _sum: { dialsInitiated: true },
    });
    expect(agg._sum.dialsInitiated).toBe(1);
  });

  it("rethrows when the DB insert fails after Twilio create (orphan path)", async () => {
    // Twilio returns a SID that already exists in the DB (from the test above) →
    // the Call insert hits the unique providerCallSid constraint → placeCall
    // logs and rethrows (reconciliation would cancel the orphan Twilio call).
    const dupClient: TwilioCallCreator = {
      calls: { create: async () => ({ sid: `${CALL_PREFIX}1` }) },
    };
    await expect(
      placeCall(
        prisma,
        {
          organizationId: ORG,
          callMethod: "power",
          callerId: "+15555550100",
          toPhone: "+15555550188",
          contactPhoneId: "cph_place_dup",
        },
        { client: dupClient, webhookBase: "https://crm.example.com/api/telephony/webhook" },
      ),
    ).rejects.toThrow();
  });
});
