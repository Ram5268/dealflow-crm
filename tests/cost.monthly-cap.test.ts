import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import type { PrismaClient } from "@prisma/client";
import { prismaPerf } from "./setup/pg";
import { monthlyCapStatus } from "@/lib/telephony/cost/monthlyCap";

const ORG = "org_cost";
const P = "CA_cost_";
let prisma: PrismaClient;
const savedCap = process.env.TWILIO_MONTHLY_SPEND_CAP_USD;

beforeAll(async () => {
  prisma = prismaPerf(4);
  await prisma.$connect();
});
beforeEach(async () => {
  await prisma.call.deleteMany({ where: { providerCallSid: { startsWith: P } } });
});
afterAll(async () => {
  await prisma.call.deleteMany({ where: { providerCallSid: { startsWith: P } } });
  if (savedCap === undefined) delete process.env.TWILIO_MONTHLY_SPEND_CAP_USD;
  else process.env.TWILIO_MONTHLY_SPEND_CAP_USD = savedCap;
  await prisma.$disconnect();
});

async function seedCost(sid: string, cost: string) {
  await prisma.call.create({
    data: {
      organizationId: ORG,
      direction: "outbound",
      callMethod: "power",
      localPhone: "+15555550100",
      remotePhone: "+15555550101",
      providerCallSid: sid,
      source: "dealflow-crm",
      cost,
      activityAt: new Date(),
    },
  });
}

describe("monthlyCapStatus", () => {
  it("not exceeded when month-to-date spend is under the cap", async () => {
    process.env.TWILIO_MONTHLY_SPEND_CAP_USD = "200";
    await seedCost(`${P}1`, "10.00");
    const s = await monthlyCapStatus(prisma);
    expect(s.capUsd).toBe(200);
    expect(s.spendUsd).toBeGreaterThanOrEqual(10);
    expect(s.exceeded).toBe(false);
  });

  it("exceeded when spend reaches the cap", async () => {
    process.env.TWILIO_MONTHLY_SPEND_CAP_USD = "5";
    await seedCost(`${P}2`, "6.00");
    const s = await monthlyCapStatus(prisma);
    expect(s.exceeded).toBe(true);
  });
});
