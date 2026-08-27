import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import type { PrismaClient } from "@prisma/client";
import { prismaPerf, listenCrmCall, type CrmCallListener } from "./setup/pg";
import { runPacingTick } from "@/lib/telephony/pacing/worker";
import { createDialSession } from "@/lib/telephony/dial-sessions/create";
import { clearHalt } from "@/lib/telephony/pacing/haltState";
import { minuteBucketUtc } from "@/lib/telephony/pacing/metrics";

const ORG = "org_wk_test";
const USER = "user_wk_test";
let prisma: PrismaClient;
let listener: CrmCallListener;
const savedCap = process.env.TWILIO_MONTHLY_SPEND_CAP_USD;
const savedApproved = process.env.LOSER_TWIML_APPROVED;

async function wipeAllMetrics() {
  await prisma.pacingMetric.deleteMany({}); // global — deterministic rolling calc
}
async function seedMetric(dialsInitiated: number, abandonedCalls: number, amdFalsePositive = 0) {
  await prisma.pacingMetric.create({
    data: {
      organizationId: ORG,
      dialSessionId: null,
      minuteBucket: minuteBucketUtc(new Date()),
      dialsInitiated,
      abandonedCalls,
      amdFalsePositive,
    },
  });
}
async function makeSession(lineCount: number, maxLineCount = 3) {
  return prisma.dialSession.create({
    data: {
      organizationId: ORG,
      userId: USER,
      sourceType: "saved-search",
      sourceValue: "save_x",
      method: "power",
      lineCount,
      maxLineCount,
      callerId: "+15555550100",
      status: "active",
    },
  });
}

beforeAll(async () => {
  prisma = prismaPerf(6);
  await prisma.$connect();
  await prisma.dialSession.deleteMany({ where: { organizationId: ORG } });
  await prisma.user.deleteMany({ where: { id: USER } });
  await prisma.organization.deleteMany({ where: { id: ORG } });
  await prisma.organization.create({ data: { id: ORG, slug: "org-wk-test", name: "WK" } });
  await prisma.user.create({ data: { id: USER, organizationId: ORG, email: "wk@test.local", displayName: "WK" } });
  process.env.TWILIO_MONTHLY_SPEND_CAP_USD = "100000"; // keep spend out of it
  process.env.LOSER_TWIML_APPROVED = "true";
  listener = await listenCrmCall();
});
beforeEach(async () => {
  await wipeAllMetrics();
  await prisma.dialSession.deleteMany({ where: { organizationId: ORG } });
});
afterAll(async () => {
  await wipeAllMetrics();
  await prisma.dialSession.deleteMany({ where: { organizationId: ORG } });
  await prisma.user.deleteMany({ where: { id: USER } });
  await prisma.organization.deleteMany({ where: { id: ORG } });
  if (savedCap === undefined) delete process.env.TWILIO_MONTHLY_SPEND_CAP_USD;
  else process.env.TWILIO_MONTHLY_SPEND_CAP_USD = savedCap;
  if (savedApproved === undefined) delete process.env.LOSER_TWIML_APPROVED;
  else process.env.LOSER_TWIML_APPROVED = savedApproved;
  await listener.close();
  await prisma.$disconnect();
});

describe("runPacingTick — band adjustments + emission", () => {
  it("low abandonment (band 1) increases lineCount and emits pacing-update", async () => {
    await seedMetric(1000, 5); // 0.5% → band 1 (increase)
    const s = await makeSession(1, 3);

    const result = await runPacingTick(prisma);
    expect(result.halted).toBe(false);
    expect(result.abandonment).toBeCloseTo(0.005, 4);

    const updated = await prisma.dialSession.findUnique({ where: { id: s.id } });
    expect(updated?.lineCount).toBe(2); // 1 → min(1+1, 3)

    const evt = await listener.waitFor(
      (e) => e.type === "dial-session.pacing-update" && e.dialSessionId === s.id,
    );
    expect(evt.currentLineCount).toBe(2);
    expect(typeof evt.abandonment30d).toBe("number");
    expect(evt).not.toHaveProperty("eventName");
  });

  it("mid abandonment (band 3) decreases lineCount", async () => {
    await seedMetric(1000, 22); // 2.2% → band 3 (decrease)
    const s = await makeSession(3, 3);
    await runPacingTick(prisma);
    const updated = await prisma.dialSession.findUnique({ where: { id: s.id } });
    expect(updated?.lineCount).toBe(2); // 3 → max(3-1,1)
  });
});

describe("circuit breaker — halt via worker → 503 → resume", () => {
  it(">2.8% abandonment halts all sessions and blocks new dial sessions with 503", async () => {
    await seedMetric(1000, 30); // 3.0% → band 5 (halt)
    const s = await makeSession(2, 3);

    const result = await runPacingTick(prisma);
    expect(result.halted).toBe(true);
    expect(result.haltReason).toBe("abandonment");

    const paused = await prisma.dialSession.findUnique({ where: { id: s.id } });
    expect(paused?.status).toBe("paused");
    expect(paused?.lineCount).toBe(0);

    // New dial session refused while halted.
    const refused = await createDialSession(
      prisma,
      { viewId: "save_x", method: "power", lineCount: 1, callerId: "+15555550100" },
      { organizationId: ORG, userId: USER },
    );
    expect(refused).toMatchObject({ ok: false, status: 503, body: { error: "pacing_halted" } });

    // Resume clears the breaker.
    await clearHalt(prisma);
    const allowed = await createDialSession(
      prisma,
      { viewId: "save_x", method: "power", lineCount: 1, callerId: "+15555550100" },
      { organizationId: ORG, userId: USER },
    );
    expect(allowed.ok).toBe(true);
  });
});
