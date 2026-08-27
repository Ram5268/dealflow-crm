import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { PrismaClient } from "@prisma/client";
import { prismaPerf, listenCrmCall, type CrmCallListener } from "../setup/pg";
import { handleAmdWebhook } from "@/lib/telephony/twilio/voiceWebhook";
import { CallConnectedEvent } from "../../contracts/tests/schemas";

const ORG = "org_emit_conn";
const USER = "user_emit_conn";
const P = "CA_emit_conn_";
let prisma: PrismaClient;
let listener: CrmCallListener;
let sessionId: string;

beforeAll(async () => {
  prisma = prismaPerf(4);
  await prisma.$connect();
  await prisma.call.deleteMany({ where: { providerCallSid: { startsWith: P } } });
  await prisma.dialSession.deleteMany({ where: { organizationId: ORG } });
  await prisma.user.deleteMany({ where: { id: USER } });
  await prisma.organization.deleteMany({ where: { id: ORG } });
  await prisma.organization.create({ data: { id: ORG, slug: "org-emit-conn", name: "EC" } });
  await prisma.user.create({ data: { id: USER, organizationId: ORG, email: "ec@test.local", displayName: "EC" } });
  const s = await prisma.dialSession.create({
    data: {
      organizationId: ORG,
      userId: USER,
      sourceType: "saved-search",
      sourceValue: "save_x",
      method: "predictive",
      lineCount: 1,
      callerId: "+15555550100",
    },
  });
  sessionId = s.id;
  listener = await listenCrmCall();
});
afterAll(async () => {
  await prisma.call.deleteMany({ where: { providerCallSid: { startsWith: P } } });
  await prisma.dialSession.deleteMany({ where: { organizationId: ORG } });
  await prisma.user.deleteMany({ where: { id: USER } });
  await prisma.organization.deleteMany({ where: { id: ORG } });
  await listener.close();
  await prisma.$disconnect();
});

describe("emits call.connected matching the frozen contract", () => {
  it("payload parses against CallConnectedEvent (type discriminant, no eventName)", async () => {
    const call = await prisma.call.create({
      data: {
        organizationId: ORG,
        leadId: "lead_e1",
        contactId: "contact_e1",
        dialSessionId: sessionId,
        direction: "outbound",
        callMethod: "predictive",
        localPhone: "+15555550100",
        remotePhone: "+15555550101",
        providerCallSid: `${P}1`,
        source: "dealflow-crm",
        status: "in-progress",
      },
    });
    await prisma.callLeg.create({
      data: { callId: call.id, contactPhoneId: "cph_e1", providerLegSid: `${P}leg1` },
    });

    await handleAmdWebhook(prisma, { CallSid: `${P}leg1`, AnsweredBy: "human" });
    const evt = await listener.waitFor((e) => e.callId === call.id && e.type === "call.connected");

    // Exact contract conformance.
    const parsed = CallConnectedEvent.parse(evt);
    expect(parsed.type).toBe("call.connected");
    expect(parsed.dialSessionId).toBe(sessionId);
    expect(parsed.leadId).toBe("lead_e1");
    expect(parsed.remotePhone).toBe("+15555550101");
    expect(evt).not.toHaveProperty("eventName");
  });
});
