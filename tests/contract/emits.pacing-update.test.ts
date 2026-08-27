import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import type { PrismaClient } from "@prisma/client";
import { prismaPerf, listenCrmCall, type CrmCallListener } from "../setup/pg";
import { runPacingTick } from "@/lib/telephony/pacing/worker";
import { minuteBucketUtc } from "@/lib/telephony/pacing/metrics";
import { PacingUpdateEvent } from "../../contracts/tests/schemas";

const ORG = "org_emit_pace";
const USER = "user_emit_pace";
let prisma: PrismaClient;
let listener: CrmCallListener;
const savedCap = process.env.TWILIO_MONTHLY_SPEND_CAP_USD;

beforeAll(async () => {
  prisma = prismaPerf(4);
  await prisma.$connect();
  await prisma.dialSession.deleteMany({ where: { organizationId: ORG } });
  await prisma.user.deleteMany({ where: { id: USER } });
  await prisma.organization.deleteMany({ where: { id: ORG } });
  await prisma.organization.create({ data: { id: ORG, slug: "org-emit-pace", name: "EP" } });
  await prisma.user.create({ data: { id: USER, organizationId: ORG, email: "ep@test.local", displayName: "EP" } });
  process.env.TWILIO_MONTHLY_SPEND_CAP_USD = "100000";
  listener = await listenCrmCall();
});
beforeEach(async () => {
  await prisma.pacingMetric.deleteMany({});
  await prisma.dialSession.deleteMany({ where: { organizationId: ORG } });
});
afterAll(async () => {
  await prisma.pacingMetric.deleteMany({});
  await prisma.dialSession.deleteMany({ where: { organizationId: ORG } });
  await prisma.user.deleteMany({ where: { id: USER } });
  await prisma.organization.deleteMany({ where: { id: ORG } });
  if (savedCap === undefined) delete process.env.TWILIO_MONTHLY_SPEND_CAP_USD;
  else process.env.TWILIO_MONTHLY_SPEND_CAP_USD = savedCap;
  await listener.close();
  await prisma.$disconnect();
});

describe("emits dial-session.pacing-update matching the frozen contract (§13 S5)", () => {
  it("payload parses against PacingUpdateEvent with band + reason + type", async () => {
    await prisma.pacingMetric.create({
      data: {
        organizationId: ORG,
        minuteBucket: minuteBucketUtc(new Date()),
        dialsInitiated: 1000,
        abandonedCalls: 22, // 2.2% → band 2_0_to_2_5, decrease
      },
    });
    const s = await prisma.dialSession.create({
      data: {
        organizationId: ORG,
        userId: USER,
        sourceType: "saved-search",
        sourceValue: "save_x",
        method: "power",
        lineCount: 3,
        callerId: "+15555550100",
        status: "active",
      },
    });

    await runPacingTick(prisma);
    const evt = await listener.waitFor(
      (e) => e.type === "dial-session.pacing-update" && e.sessionId === s.id,
    );

    const parsed = PacingUpdateEvent.parse(evt);
    expect(parsed.type).toBe("dial-session.pacing-update");
    expect(parsed.sessionId).toBe(s.id);
    expect(parsed.band).toBe("2_0_to_2_5");
    expect(parsed.reason).toBe("decrease");
    expect(parsed.lineCount).toBe(2);
    expect(typeof parsed.rollingAbandonment).toBe("number");
    expect(evt).not.toHaveProperty("eventName");
  });
});
