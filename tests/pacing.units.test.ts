import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import type { PrismaClient } from "@prisma/client";
import { prismaPerf } from "./setup/pg";
import {
  rollingAbandonment,
  rollingAmdFpRate,
  monthToDateSpendUsd,
  minuteBucketUtc,
  SYSTEM_ORG,
} from "@/lib/telephony/pacing/metrics";
import { pacingStatus } from "@/lib/telephony/pacing/status";
import { setHalt, clearHalt } from "@/lib/telephony/pacing/haltState";
import { runPacingTick } from "@/lib/telephony/pacing/worker";

const ORG = "org_pu_test";
const USER = "user_pu_test";
const CALL_SID = "CA_pu_spend";
let prisma: PrismaClient;
const savedCap = process.env.TWILIO_MONTHLY_SPEND_CAP_USD;

beforeAll(async () => {
  prisma = prismaPerf(6);
  await prisma.$connect();
  await prisma.organization.deleteMany({ where: { id: ORG } });
  await prisma.organization.create({ data: { id: ORG, slug: "org-pu", name: "PU" } });
  await prisma.user.create({ data: { id: USER, organizationId: ORG, email: "pu@test.local", displayName: "PU" } });
});
beforeEach(async () => {
  await prisma.pacingMetric.deleteMany({});
  await prisma.call.deleteMany({ where: { providerCallSid: { startsWith: "CA_pu_" } } });
  await prisma.dialSession.deleteMany({ where: { organizationId: ORG } });
});
afterAll(async () => {
  await prisma.pacingMetric.deleteMany({});
  await prisma.call.deleteMany({ where: { providerCallSid: { startsWith: "CA_pu_" } } });
  await prisma.dialSession.deleteMany({ where: { organizationId: ORG } });
  await prisma.user.deleteMany({ where: { id: USER } });
  await prisma.organization.deleteMany({ where: { id: ORG } });
  if (savedCap === undefined) delete process.env.TWILIO_MONTHLY_SPEND_CAP_USD;
  else process.env.TWILIO_MONTHLY_SPEND_CAP_USD = savedCap;
});

describe("rolling metrics", () => {
  it("zero denominator → 0 for abandonment and AMD-FP", async () => {
    expect(await rollingAbandonment(prisma)).toBe(0);
    expect(await rollingAmdFpRate(prisma)).toBe(0);
  });

  it("computes abandonment with the AMD-FP double-count", async () => {
    await prisma.pacingMetric.create({
      data: {
        organizationId: ORG,
        minuteBucket: minuteBucketUtc(new Date()),
        dialsInitiated: 1000,
        abandonedCalls: 10,
        amdFalsePositive: 5,
      },
    });
    expect(await rollingAbandonment(prisma)).toBeCloseTo(0.015, 5); // (10+5)/1000
    expect(await rollingAmdFpRate(prisma)).toBeCloseTo(0.005, 5); // 5/1000
  });

  it("month-to-date spend sums Call.cost (0 when none)", async () => {
    expect(await monthToDateSpendUsd(prisma)).toBe(0);
    await prisma.call.create({
      data: {
        organizationId: ORG,
        direction: "outbound",
        callMethod: "power",
        localPhone: "+15555550100",
        remotePhone: "+15555550101",
        providerCallSid: CALL_SID,
        source: "dealflow-crm",
        cost: "1.2345",
      },
    });
    expect(await monthToDateSpendUsd(prisma)).toBeCloseTo(1.2345, 4);
  });

  it("month-to-date spend excludes SYSTEM_ORG sentinel rows", async () => {
    // Sentinel/system rows are not dialing activity. Counting them inflates
    // spend against TWILIO_MONTHLY_SPEND_CAP_USD and can trip the global
    // spend-halt breaker on money that was never spent.
    await prisma.call.create({
      data: {
        organizationId: SYSTEM_ORG,
        direction: "outbound",
        callMethod: "power",
        localPhone: "+15555550100",
        remotePhone: "+15555550101",
        providerCallSid: "CA_pu_system",
        source: "dealflow-crm",
        cost: "999.00",
      },
    });
    expect(await monthToDateSpendUsd(prisma)).toBe(0);

    // ...and a real org's spend is still counted alongside it.
    await prisma.call.create({
      data: {
        organizationId: ORG,
        direction: "outbound",
        callMethod: "power",
        localPhone: "+15555550100",
        remotePhone: "+15555550101",
        providerCallSid: "CA_pu_real",
        source: "dealflow-crm",
        cost: "2.50",
      },
    });
    expect(await monthToDateSpendUsd(prisma)).toBeCloseTo(2.5, 4);
  });
});

describe("pacingStatus", () => {
  it("reports rolling percentages, halt flag, and per-session lineCount", async () => {
    await prisma.pacingMetric.create({
      data: {
        organizationId: ORG,
        minuteBucket: minuteBucketUtc(new Date()),
        dialsInitiated: 1000,
        abandonedCalls: 20,
      },
    });
    const s = await prisma.dialSession.create({
      data: {
        organizationId: ORG,
        userId: USER,
        sourceType: "saved-search",
        sourceValue: "save_x",
        method: "power",
        lineCount: 2,
        callerId: "+15555550100",
      },
    });
    await setHalt(prisma, "spend");

    const status = await pacingStatus(prisma, s.id);
    expect(status.currentLineCount).toBe(2);
    expect(status.abandonment30dPct).toBeCloseTo(2.0, 4);
    expect(status.halted).toBe(true);
    expect(status.haltReason).toBe("spend");

    await clearHalt(prisma);
    const noSession = await pacingStatus(prisma);
    expect(noSession.currentLineCount).toBeNull();
    expect(noSession.halted).toBe(false);
  });
});

describe("runPacingTick — spend-cap halt", () => {
  it("month-to-date spend ≥ cap halts with reason spend", async () => {
    process.env.TWILIO_MONTHLY_SPEND_CAP_USD = "1";
    await prisma.call.create({
      data: {
        organizationId: ORG,
        direction: "outbound",
        callMethod: "power",
        localPhone: "+15555550100",
        remotePhone: "+15555550101",
        providerCallSid: "CA_pu_spend2",
        source: "dealflow-crm",
        cost: "5.00",
      },
    });
    const s = await prisma.dialSession.create({
      data: {
        organizationId: ORG,
        userId: USER,
        sourceType: "saved-search",
        sourceValue: "save_x",
        method: "power",
        lineCount: 2,
        callerId: "+15555550100",
        status: "active",
      },
    });

    const result = await runPacingTick(prisma);
    expect(result.halted).toBe(true);
    expect(result.haltReason).toBe("spend");
    const paused = await prisma.dialSession.findUnique({ where: { id: s.id } });
    expect(paused?.status).toBe("paused");
  });
});
