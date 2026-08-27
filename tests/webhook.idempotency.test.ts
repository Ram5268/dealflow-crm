import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { PrismaClient } from "@prisma/client";
import { prismaPerf, listenCrmCall, type CrmCallListener } from "./setup/pg";
import { handleStatusWebhook } from "@/lib/telephony/twilio/statusWebhook";
import { handleAmdWebhook } from "@/lib/telephony/twilio/voiceWebhook";

const CALL_PREFIX = "CA_idem_";
const ORG_PREFIX = "org_idem_";

let prisma: PrismaClient;
let listener: CrmCallListener;

async function cleanup() {
  await prisma.call.deleteMany({ where: { providerCallSid: { startsWith: CALL_PREFIX } } });
  await prisma.pacingMetric.deleteMany({ where: { organizationId: { startsWith: ORG_PREFIX } } });
}

beforeAll(async () => {
  prisma = prismaPerf(6);
  await prisma.$connect();
  await cleanup();
  listener = await listenCrmCall();
});

afterAll(async () => {
  await cleanup();
  await listener?.close();
  await prisma?.$disconnect();
});

function eventsFor(callId: string, type: string) {
  return listener.events.filter((e) => e.callId === callId && e.type === type);
}

describe("status webhook — idempotent call.completed emission", () => {
  it("replayed 3× emits exactly one call.completed with wire-correct shape", async () => {
    const call = await prisma.call.create({
      data: {
        organizationId: `${ORG_PREFIX}status`,
        direction: "outbound",
        callMethod: "predictive",
        localPhone: "+15555550100",
        remotePhone: "+15555550111",
        providerCallSid: `${CALL_PREFIX}status_1`,
        source: "dealflow-crm",
        status: "in-progress",
      },
    });

    const params = {
      CallSid: `${CALL_PREFIX}status_1`,
      CallStatus: "completed",
      CallDuration: "42",
      Price: "-0.0130", // Twilio prices are negative debits
    };

    const r1 = await handleStatusWebhook(prisma, params);
    const r2 = await handleStatusWebhook(prisma, params);
    const r3 = await handleStatusWebhook(prisma, params);
    expect([r1.emitted, r2.emitted, r3.emitted]).toEqual([true, false, false]);

    const evt = await listener.waitFor((e) => e.callId === call.id && e.type === "call.completed");
    expect(eventsFor(call.id, "call.completed")).toHaveLength(1);

    // Wire-format assertions (§8.3): type discriminant, no eventName, cost string.
    expect(evt.type).toBe("call.completed");
    expect(evt).not.toHaveProperty("eventName");
    expect(evt.disposition).toBe("answered");
    expect(evt.duration).toBe(42);
    expect(typeof evt.cost).toBe("string");
    expect(Number(evt.cost)).toBeCloseTo(0.013, 6);
    expect(typeof evt.correlationId).toBe("string");

    const updated = await prisma.call.findUnique({ where: { id: call.id } });
    expect(updated?.status).toBe("completed");
    expect(updated?.disposition).toBe("answered");
    expect(updated?.emittedAt).not.toBeNull();
  });

  it("non-terminal status (ringing→in-progress) updates without emitting", async () => {
    const call = await prisma.call.create({
      data: {
        organizationId: `${ORG_PREFIX}status`,
        direction: "outbound",
        callMethod: "power",
        localPhone: "+15555550100",
        remotePhone: "+15555550177",
        providerCallSid: `${CALL_PREFIX}status_2`,
        source: "dealflow-crm",
        status: "created",
      },
    });
    // No CallDuration / Price → exercises the optional-field branches.
    const r = await handleStatusWebhook(prisma, {
      CallSid: `${CALL_PREFIX}status_2`,
      CallStatus: "ringing",
    });
    expect(r).toMatchObject({ handled: true, emitted: false, localStatus: "in-progress" });
    expect(eventsFor(call.id, "call.completed")).toHaveLength(0);
    const updated = await prisma.call.findUnique({ where: { id: call.id } });
    expect(updated?.status).toBe("in-progress");
    expect(updated?.emittedAt).toBeNull();
  });

  it("unknown CallSid → no-op (recon owns orphans)", async () => {
    const r = await handleStatusWebhook(prisma, { CallSid: "CA_idem_nonexistent", CallStatus: "completed" });
    expect(r).toMatchObject({ handled: false, emitted: false });
  });

  it("unknown Twilio status → no-op", async () => {
    const r = await handleStatusWebhook(prisma, { CallSid: `${CALL_PREFIX}status_1`, CallStatus: "teleported" });
    expect(r).toMatchObject({ handled: false, localStatus: null });
  });
});

describe("voice/AMD webhook — idempotent bridge + call.connected", () => {
  it("human replayed 3× → one amdResult write, one call.connected, disposition won", async () => {
    const call = await prisma.call.create({
      data: {
        organizationId: `${ORG_PREFIX}voice`,
        leadId: "lead_voice_1",
        contactId: "contact_voice_1",
        direction: "outbound",
        callMethod: "predictive",
        localPhone: "+15555550100",
        remotePhone: "+15555550122",
        providerCallSid: `${CALL_PREFIX}voice_1`,
        source: "dealflow-crm",
        status: "in-progress",
      },
    });
    const legSid = `${CALL_PREFIX}voice_leg_1`;
    await prisma.callLeg.create({
      data: { callId: call.id, contactPhoneId: "cph_voice_1", providerLegSid: legSid },
    });

    const params = { CallSid: legSid, AnsweredBy: "human" };
    const r1 = await handleAmdWebhook(prisma, params);
    const r2 = await handleAmdWebhook(prisma, params);
    const r3 = await handleAmdWebhook(prisma, params);

    expect(r1.outcome).toBe("bridged-winner");
    expect(r1.emittedConnected).toBe(true);
    expect(r2.outcome).toBe("replay");
    expect(r3.outcome).toBe("replay");
    expect(r1.twiml).toContain(`conf_${call.id}`);
    expect(r2.twiml).toContain(`conf_${call.id}`); // replay returns same TwiML

    const evt = await listener.waitFor((e) => e.callId === call.id && e.type === "call.connected");
    expect(eventsFor(call.id, "call.connected")).toHaveLength(1);
    expect(evt.type).toBe("call.connected");
    expect(evt).not.toHaveProperty("eventName");
    expect(evt.remotePhone).toBe("+15555550122");
    expect(evt.leadId).toBe("lead_voice_1");
    expect(evt.contactId).toBe("contact_voice_1");

    const leg = await prisma.callLeg.findFirst({ where: { providerLegSid: legSid } });
    expect(leg?.amdResult).toBe("human");
    expect(leg?.disposition).toBe("won");
    expect(leg?.connectedAt).not.toBeNull();
  });

  it("unknown leg SID → hangup, no crash", async () => {
    const r = await handleAmdWebhook(prisma, { CallSid: "CA_idem_no_such_leg", AnsweredBy: "human" });
    expect(r.outcome).toBe("unknown-leg");
    expect(r.twiml).toContain("<Hangup/>");
  });

  it("machine → voicemail hangup, no bridge, no call.connected", async () => {
    const call = await prisma.call.create({
      data: {
        organizationId: `${ORG_PREFIX}voice`,
        direction: "outbound",
        callMethod: "predictive",
        localPhone: "+15555550100",
        remotePhone: "+15555550133",
        providerCallSid: `${CALL_PREFIX}voice_2`,
        source: "dealflow-crm",
        status: "in-progress",
      },
    });
    const legSid = `${CALL_PREFIX}voice_leg_2`;
    await prisma.callLeg.create({
      data: { callId: call.id, contactPhoneId: "cph_voice_2", providerLegSid: legSid },
    });

    const r = await handleAmdWebhook(prisma, { CallSid: legSid, AnsweredBy: "machine_end_beep" });
    expect(r.outcome).toBe("voicemail");
    expect(r.twiml).toContain("<Hangup/>");
    expect(eventsFor(call.id, "call.connected")).toHaveLength(0);

    const leg = await prisma.callLeg.findFirst({ where: { providerLegSid: legSid } });
    expect(leg?.amdResult).toBe("machine");
    expect(leg?.disposition).toBe("vm-answer");
    const updated = await prisma.call.findUnique({ where: { id: call.id } });
    expect(updated?.disposition).toBe("vm-answer");

    // Replay with a DIFFERENT AnsweredBy → honors the original decision (hangup),
    // logs a warning, does not re-decide.
    const replay = await handleAmdWebhook(prisma, { CallSid: legSid, AnsweredBy: "human" });
    expect(replay.outcome).toBe("replay");
    expect(replay.twiml).toContain("<Hangup/>");
  });

  it("second human leg AFTER a winner (sequential) → dropped-loser via prior-winner check", async () => {
    const call = await prisma.call.create({
      data: {
        organizationId: `${ORG_PREFIX}seq`,
        direction: "outbound",
        callMethod: "predictive",
        localPhone: "+15555550100",
        remotePhone: "+15555550166",
        providerCallSid: `${CALL_PREFIX}seq_call`,
        source: "dealflow-crm",
        status: "in-progress",
      },
    });
    const legA = `${CALL_PREFIX}seq_leg_A`;
    const legB = `${CALL_PREFIX}seq_leg_B`;
    await prisma.callLeg.createMany({
      data: [
        { callId: call.id, contactPhoneId: "cph_seq_A", providerLegSid: legA },
        { callId: call.id, contactPhoneId: "cph_seq_B", providerLegSid: legB },
      ],
    });

    const first = await handleAmdWebhook(prisma, { CallSid: legA, AnsweredBy: "human" });
    const second = await handleAmdWebhook(prisma, { CallSid: legB, AnsweredBy: "human" });
    expect(first.outcome).toBe("bridged-winner");
    expect(second.outcome).toBe("dropped-loser"); // advisory lock free, but prior winner exists
  });
});

describe("two-legs-answer race via the webhook", () => {
  it("two human legs for one call → exactly one winner, one dropped-loser, one abandoned", async () => {
    const org = `${ORG_PREFIX}race`;
    const call = await prisma.call.create({
      data: {
        organizationId: org,
        direction: "outbound",
        callMethod: "predictive",
        localPhone: "+15555550100",
        remotePhone: "+15555550144",
        providerCallSid: `${CALL_PREFIX}race_call`,
        source: "dealflow-crm",
        status: "in-progress",
      },
    });
    const legA = `${CALL_PREFIX}race_leg_A`;
    const legB = `${CALL_PREFIX}race_leg_B`;
    await prisma.callLeg.createMany({
      data: [
        { callId: call.id, contactPhoneId: "cph_race_A", providerLegSid: legA },
        { callId: call.id, contactPhoneId: "cph_race_B", providerLegSid: legB },
      ],
    });

    // Fire both AMD-human callbacks concurrently. Advisory lock (concurrency) +
    // persistent prior-winner check (sequencing) guarantee exactly one winner.
    const [ra, rb] = await Promise.all([
      handleAmdWebhook(prisma, { CallSid: legA, AnsweredBy: "human" }),
      handleAmdWebhook(prisma, { CallSid: legB, AnsweredBy: "human" }),
    ]);

    const outcomes = [ra.outcome, rb.outcome].sort();
    expect(outcomes).toEqual(["bridged-winner", "dropped-loser"]);

    const legs = await prisma.callLeg.findMany({ where: { callId: call.id } });
    expect(legs.filter((l) => l.disposition === "won")).toHaveLength(1);
    const loser = legs.find((l) => l.disposition === "dropped-loser");
    expect(loser?.droppedLoserMessage).toBe(true);

    // Exactly one abandoned-call metric for this org.
    const agg = await prisma.pacingMetric.aggregate({
      where: { organizationId: org },
      _sum: { abandonedCalls: true, humansReached: true },
    });
    expect(agg._sum.abandonedCalls).toBe(1);
    expect(agg._sum.humansReached).toBe(1);

    // Exactly one call.connected for the winner.
    expect(eventsFor(call.id, "call.connected")).toHaveLength(1);
  });
});
