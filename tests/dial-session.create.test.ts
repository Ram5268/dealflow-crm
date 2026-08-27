import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import type { PrismaClient } from "@prisma/client";
import { prismaPerf } from "./setup/pg";
import { createDialSession } from "@/lib/telephony/dial-sessions/create";
import { minuteBucketUtc } from "@/lib/telephony/pacing/metrics";

const ORG = "org_ds_test";
const USER = "user_ds_test";
let prisma: PrismaClient;
const savedApproved = process.env.LOSER_TWIML_APPROVED;

async function clearSentinels() {
  await prisma.pacingMetric.deleteMany({
    where: { dialSessionId: null, currentLineCount: { in: [-1, 0] } },
  });
}

beforeAll(async () => {
  prisma = prismaPerf(4);
  await prisma.$connect();
  await prisma.dialSession.deleteMany({ where: { organizationId: ORG } });
  await prisma.user.deleteMany({ where: { id: USER } });
  await prisma.organization.deleteMany({ where: { id: ORG } });
  await prisma.organization.create({ data: { id: ORG, slug: "org-ds-test", name: "DS Test" } });
  await prisma.user.create({
    data: { id: USER, organizationId: ORG, email: "ds@test.local", displayName: "DS" },
  });
});

beforeEach(clearSentinels);

afterAll(async () => {
  await clearSentinels();
  await prisma.dialSession.deleteMany({ where: { organizationId: ORG } });
  await prisma.user.deleteMany({ where: { id: USER } });
  await prisma.organization.deleteMany({ where: { id: ORG } });
  if (savedApproved === undefined) delete process.env.LOSER_TWIML_APPROVED;
  else process.env.LOSER_TWIML_APPROVED = savedApproved;
  await prisma.$disconnect();
});

const body = (method: "power" | "predictive") => ({
  viewId: "save_x",
  method,
  lineCount: 1,
  callerId: "+15555550100",
});
const ctx = { organizationId: ORG, userId: USER };

describe("createDialSession — predictive loser-TwiML gate", () => {
  it("refuses predictive when LOSER_TWIML_APPROVED !== 'true'", async () => {
    process.env.LOSER_TWIML_APPROVED = "false";
    const r = await createDialSession(prisma, body("predictive"), ctx);
    expect(r).toEqual({ ok: false, status: 403, body: { error: "loser_twiml_unapproved" } });
  });

  it("refuses predictive when LOSER_TWIML_APPROVED is unset", async () => {
    delete process.env.LOSER_TWIML_APPROVED;
    const r = await createDialSession(prisma, body("predictive"), ctx);
    expect(r).toMatchObject({ ok: false, status: 403, body: { error: "loser_twiml_unapproved" } });
  });

  it("allows power sessions regardless of approval (no loser leg)", async () => {
    delete process.env.LOSER_TWIML_APPROVED;
    const r = await createDialSession(prisma, body("power"), ctx);
    expect(r.ok).toBe(true);
  });

  it("allows predictive when approved", async () => {
    process.env.LOSER_TWIML_APPROVED = "true";
    const r = await createDialSession(prisma, body("predictive"), ctx);
    expect(r.ok).toBe(true);
    if (r.ok) {
      const session = await prisma.dialSession.findUnique({ where: { id: r.sessionId } });
      expect(session?.method).toBe("predictive");
      expect(session?.sourceValue).toBe("save_x");
    }
  });
});

describe("createDialSession — circuit breaker", () => {
  it("returns 503 pacing_halted when globally halted", async () => {
    process.env.LOSER_TWIML_APPROVED = "true";
    await prisma.pacingMetric.create({
      data: {
        organizationId: ORG,
        dialSessionId: null,
        minuteBucket: minuteBucketUtc(new Date()),
        currentLineCount: -1,
        amdFalsePositive: 1,
      },
    });
    const r = await createDialSession(prisma, body("power"), ctx);
    expect(r).toMatchObject({ ok: false, status: 503, body: { error: "pacing_halted" } });
  });

  it("returns 503 spend_cap_reached when halted for spend", async () => {
    await prisma.pacingMetric.create({
      data: {
        organizationId: ORG,
        dialSessionId: null,
        minuteBucket: minuteBucketUtc(new Date()),
        currentLineCount: -1,
        amdFalsePositive: 2,
      },
    });
    const r = await createDialSession(prisma, body("power"), ctx);
    expect(r).toMatchObject({ ok: false, status: 503, body: { error: "spend_cap_reached" } });
  });
});
