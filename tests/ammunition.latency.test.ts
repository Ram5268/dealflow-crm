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

  it("hydrate adds < 50ms over a same-connection round-trip baseline", async () => {
    // Warm the pool so the first-query cold start isn't measured.
    for (let i = 0; i < 5; i++) {
      await prisma.$queryRaw`SELECT 1`;
      await hydrateAmmunition(prisma, callId);
    }

    // Interleaved so any network drift biases BOTH samples equally. `SELECT 1`
    // on the same Prisma pool is the cheapest possible statement, so it prices
    // one round trip; hydrate minus that is the query's own cost.
    const baseline: number[] = [];
    const hydrate: number[] = [];
    for (let i = 0; i < 20; i++) {
      const b0 = performance.now();
      await prisma.$queryRaw`SELECT 1`;
      baseline.push(performance.now() - b0);

      const h0 = performance.now();
      await hydrateAmmunition(prisma, callId);
      hydrate.push(performance.now() - h0);
    }

    const at = (xs: number[], i: number) => [...xs].sort((a, b) => a - b)[i];
    const median = (xs: number[]) => at(xs, 10); // 11th of 20
    const p95 = (xs: number[]) => at(xs, 18); // 19th of 20
    const overhead = median(hydrate) - median(baseline);

    // Absolute wall-clock is topology-dependent (dominated by client->DB RTT),
    // so it is LOGGED for visibility but never asserted on. Only the marginal
    // cost gates the build. See docs/known-drift.md "Test topology assumptions".
    // eslint-disable-next-line no-console
    console.log(
      `ammunition hydrate: overhead=${overhead.toFixed(1)}ms | ` +
        `hydrate median=${median(hydrate).toFixed(1)}ms p95=${p95(hydrate).toFixed(1)}ms | ` +
        `baseline median=${median(baseline).toFixed(1)}ms p95=${p95(baseline).toFixed(1)}ms`,
    );

    // One extra round trip costs a full RTT (~91ms from a dev laptop across
    // Railway's public proxy), so an N+1 regression blows this budget on any
    // network; the real query does single-digit ms of work.
    expect(overhead).toBeLessThan(50);
  });
});
