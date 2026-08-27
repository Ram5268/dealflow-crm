import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import type { PrismaClient } from "@prisma/client";
import { prismaPerf } from "./setup/pg";
import { isHalted } from "@/lib/telephony/pacing/haltState";
import { minuteBucketUtc } from "@/lib/telephony/pacing/metrics";

let prisma: PrismaClient;
const BASE = Date.UTC(2026, 0, 1, 0, 0, 0);

async function clearSentinels() {
  await prisma.pacingMetric.deleteMany({
    where: { dialSessionId: null, currentLineCount: { in: [-1, 0] } },
  });
}

beforeAll(async () => {
  prisma = prismaPerf(4);
  await prisma.$connect();
});
beforeEach(clearSentinels);
afterAll(async () => {
  await clearSentinels();
  await prisma?.$disconnect();
});

async function sentinel(offsetMin: number, currentLineCount: number, amdFalsePositive = 0) {
  await prisma.pacingMetric.create({
    data: {
      organizationId: "org_halt_test",
      dialSessionId: null,
      minuteBucket: minuteBucketUtc(new Date(BASE + offsetMin * 60_000)),
      currentLineCount,
      amdFalsePositive,
    },
  });
}

describe("isHalted", () => {
  it("no sentinel → not halted", async () => {
    expect(await isHalted(prisma)).toEqual({ halted: false });
  });

  it("latest sentinel currentLineCount=-1, amdFalsePositive=1 → halted abandonment", async () => {
    await sentinel(0, -1, 1);
    expect(await isHalted(prisma)).toEqual({ halted: true, reason: "abandonment" });
  });

  it("latest sentinel amdFalsePositive=2 → halted spend", async () => {
    await sentinel(0, -1, 1);
    await sentinel(1, -1, 2); // newer wins
    expect(await isHalted(prisma)).toEqual({ halted: true, reason: "spend" });
  });

  it("latest sentinel currentLineCount=0 → resumed (not halted)", async () => {
    await sentinel(0, -1, 1);
    await sentinel(2, 0); // resume, newest
    expect(await isHalted(prisma)).toEqual({ halted: false });
  });

  it("DB read failure → not-halted (health must not throw)", async () => {
    const broken = {
      pacingMetric: { findMany: async () => { throw new Error("db down"); } },
    } as unknown as PrismaClient;
    expect(await isHalted(broken)).toEqual({ halted: false });
  });
});
