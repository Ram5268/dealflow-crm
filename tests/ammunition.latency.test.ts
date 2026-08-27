import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { PrismaClient } from "@prisma/client";
import { prismaPerf } from "./setup/pg";
import { hydrateAmmunition } from "@/lib/telephony/ammunition/hydrate";

const ORG = "org_ammo_test";
const MOJO = "mojo_ammo_1";
const CALL_SID = "CA_ammo_1";
let prisma: PrismaClient;
let callId: string;

beforeAll(async () => {
  prisma = prismaPerf(6);
  await prisma.$connect();

  // Clean prior run (cascades: Contact→phones, Call→legs).
  await prisma.call.deleteMany({ where: { providerCallSid: CALL_SID } });
  await prisma.dealFlowDerivedSignal.deleteMany({ where: { mojoId: MOJO } });
  await prisma.contact.deleteMany({ where: { organizationId: ORG } });
  await prisma.lead.deleteMany({ where: { organizationId: ORG } });
  await prisma.organization.deleteMany({ where: { id: ORG } });

  await prisma.organization.create({ data: { id: ORG, slug: "org-ammo-test", name: "Ammo Test" } });
  const lead = await prisma.lead.create({
    data: {
      organizationId: ORG,
      displayName: "123 Main St Seller",
      priorityScore: 92,
      topMatchFit: 88,
      captureStatus: "hot",
      matchReason: "3BR buyer ISO within 5% of ask",
      dealflowDeepLink: "https://dealflow.app/opp/xyz",
      primaryAddressSummary: "123 Main St, Brooklyn",
      mojoId: MOJO,
    },
  });
  const contact = await prisma.contact.create({
    data: { organizationId: ORG, leadId: lead.id, displayName: "Jane Seller" },
  });
  await prisma.contactPhone.createMany({
    data: [
      { contactId: contact.id, phone: "+15555550111", phoneFormatted: "(555) 555-0111", type: "mobile", lineType: "mobile", isPrimary: true },
      { contactId: contact.id, phone: "+15555550112", phoneFormatted: "(555) 555-0112", type: "home" },
    ],
  });
  await prisma.dealFlowDerivedSignal.create({
    data: {
      organizationId: ORG,
      mojoId: MOJO,
      queueRank: 1,
      queueReason: "top priority today",
      primaryMatchFit: 88,
      primaryCaptureStatus: "hot",
      primaryMatchConfidence: "high",
      dealflowRawJson: {},
    },
  });
  const call = await prisma.call.create({
    data: {
      organizationId: ORG,
      leadId: lead.id,
      contactId: contact.id,
      direction: "outbound",
      callMethod: "power",
      localPhone: "+15555550100",
      remotePhone: "+15555550111",
      providerCallSid: CALL_SID,
      source: "dealflow-crm",
    },
  });
  callId = call.id;
});

afterAll(async () => {
  await prisma.call.deleteMany({ where: { providerCallSid: CALL_SID } });
  await prisma.dealFlowDerivedSignal.deleteMany({ where: { mojoId: MOJO } });
  await prisma.contact.deleteMany({ where: { organizationId: ORG } });
  await prisma.lead.deleteMany({ where: { organizationId: ORG } });
  await prisma.organization.deleteMany({ where: { id: ORG } });
  await prisma.$disconnect();
});

describe("hydrateAmmunition", () => {
  it("returns the full ammunition payload (lead + contact.phones + derivedSignal)", async () => {
    const data = await hydrateAmmunition(prisma, callId);
    expect(data).not.toBeNull();
    expect(data!.lead).toMatchObject({
      displayName: "123 Main St Seller",
      priorityScore: 92,
      captureStatus: "hot",
      primaryAddressSummary: "123 Main St, Brooklyn",
    });
    expect(data!.contact?.phones).toHaveLength(2);
    expect(data!.derivedSignal).toMatchObject({ queueRank: 1, primaryCaptureStatus: "hot" });
  });

  it("returns null for an unknown callId", async () => {
    expect(await hydrateAmmunition(prisma, "call_does_not_exist")).toBeNull();
  });

  it("p95 latency < 200ms across 20 runs (allow 1 outlier ≤ 500ms)", async () => {
    // Warm the connection pool so the first-query cold start isn't measured.
    for (let i = 0; i < 5; i++) await hydrateAmmunition(prisma, callId);

    const timings: number[] = [];
    for (let i = 0; i < 20; i++) {
      const t0 = performance.now();
      await hydrateAmmunition(prisma, callId);
      timings.push(performance.now() - t0);
    }
    timings.sort((a, b) => a - b);
    const p95 = timings[18]; // 19th of 20
    const max = timings[19];
    // eslint-disable-next-line no-console
    console.log(
      `ammunition hydrate: median=${timings[10].toFixed(1)}ms p95=${p95.toFixed(1)}ms max=${max.toFixed(1)}ms`,
    );
    expect(p95).toBeLessThan(200);
    expect(max).toBeLessThan(500); // the single allowed outlier
  });
});
