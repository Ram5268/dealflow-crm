import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import type { PrismaClient } from "@prisma/client";
import { prismaPerf } from "./setup/pg";
import { runDialTick, type DialSessionRow, type DialTickDeps } from "@/lib/telephony/dial-loop/session";
import { getQueue } from "@/lib/telephony/dial-loop/queueClient";
import { checkCallable } from "@/lib/telephony/dial-loop/compliance";
import type { CallableResult, QueueLead } from "@/lib/telephony/dial-loop/schemas";

const ORG = "org_dl_test";
const CALL_PREFIX = "CA_dl_";
let prisma: PrismaClient;

/** A fetch that returns a fixed JSON body/status. */
function jsonFetch(status: number, body: unknown): typeof fetch {
  return (async () =>
    new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    })) as unknown as typeof fetch;
}
const throwingFetch: typeof fetch = (async () => {
  throw new Error("network down");
}) as unknown as typeof fetch;

function session(overrides: Partial<DialSessionRow> = {}): DialSessionRow {
  return {
    id: "dial_dl_test",
    organizationId: ORG,
    userId: null,
    method: "power",
    lineCount: 2,
    callerId: "+15555550100",
    sourceValue: "save_x",
    status: "active",
    ...overrides,
  };
}

function lead(over: Partial<QueueLead> & { primaryPhoneId: string }): QueueLead {
  return {
    leadId: `lead_${over.primaryPhoneId}`,
    contactId: `contact_${over.primaryPhoneId}`,
    primaryPhoneE164: "+15555550101",
    ...over,
  };
}

const allCallable = (ids: string[]): Promise<CallableResult[]> =>
  Promise.resolve(ids.map((id) => ({ contactPhoneId: id, phone: "+15555550101", callable: true, reasons: [] })));

beforeAll(async () => {
  prisma = prismaPerf(6);
  await prisma.$connect();
});
beforeEach(async () => {
  await prisma.call.deleteMany({ where: { providerCallSid: { startsWith: CALL_PREFIX } } });
});
afterAll(async () => {
  await prisma.call.deleteMany({ where: { providerCallSid: { startsWith: CALL_PREFIX } } });
  await prisma.$disconnect();
});

async function seedDroppedLoserLeg(contactPhoneId: string, startedAt: Date, sid: string) {
  const call = await prisma.call.create({
    data: {
      organizationId: ORG,
      direction: "outbound",
      callMethod: "predictive",
      localPhone: "+15555550100",
      remotePhone: "+15555550101",
      providerCallSid: sid,
      source: "dealflow-crm",
    },
  });
  await prisma.callLeg.create({
    data: {
      callId: call.id,
      contactPhoneId,
      providerLegSid: `${sid}_leg`,
      disposition: "dropped-loser",
      droppedLoserMessage: true,
      startedAt,
    },
  });
}

describe("runDialTick — inline compliance fail-closed", () => {
  it("compliance error → no dial placed, no Call row", async () => {
    const placeCall = vi.fn();
    const deps: DialTickDeps = {
      getQueue: async () => ({
        view: { id: "v", name: "V" },
        leads: [lead({ primaryPhoneId: "cph_fc_1" }), lead({ primaryPhoneId: "cph_fc_2" })],
        generatedAt: "2026-01-01T00:00:00Z",
      }),
      // Real compliance client with a throwing fetch → fail-closed.
      checkCallable: (ids) => checkCallable({ baseUrl: "http://mock", fetchImpl: throwingFetch }, ids),
      placeCall,
    };
    const r = await runDialTick(prisma, session(), deps);
    expect(placeCall).not.toHaveBeenCalled();
    expect(r.placed).toBe(0);
    expect(r.blocked).toBe(2);
  });
});

describe("runDialTick — 72h dropped-loser exclusion (Agent B local)", () => {
  it("excludes a contact with a dropped-loser leg within 72h; includes one at 73h", async () => {
    await seedDroppedLoserLeg("cph_dl_recent", new Date(Date.now() - 1 * 60 * 60 * 1000), `${CALL_PREFIX}recent`);
    await seedDroppedLoserLeg("cph_dl_old", new Date(Date.now() - 73 * 60 * 60 * 1000), `${CALL_PREFIX}old`);

    const placeCall = vi.fn().mockResolvedValue({ callId: "c", providerCallSid: "s" });
    const deps: DialTickDeps = {
      getQueue: async () => ({
        view: { id: "v", name: "V" },
        leads: [
          lead({ primaryPhoneId: "cph_dl_recent" }),
          lead({ primaryPhoneId: "cph_dl_old" }),
          lead({ primaryPhoneId: "cph_dl_fresh" }),
        ],
        generatedAt: "2026-01-01T00:00:00Z",
      }),
      checkCallable: allCallable,
      placeCall,
    };
    const r = await runDialTick(prisma, session({ lineCount: 5 }), deps);
    const dialed = placeCall.mock.calls.map((c) => c[0].contactPhoneId);
    expect(dialed).not.toContain("cph_dl_recent"); // excluded (1h ago)
    expect(dialed).toContain("cph_dl_old"); // 73h → allowed
    expect(dialed).toContain("cph_dl_fresh"); // never a loser
    expect(r.placed).toBe(2);
  });
});

describe("runDialTick — timezone-unresolved (B does not synthesize; C fail-closes)", () => {
  it("timezone:null lead → C returns callable:false timezone_unresolved → no dial", async () => {
    const placeCall = vi.fn();
    const deps: DialTickDeps = {
      getQueue: async () => ({
        view: { id: "v", name: "V" },
        leads: [lead({ primaryPhoneId: "cph_tz", timezone: null })],
        generatedAt: "2026-01-01T00:00:00Z",
      }),
      checkCallable: async (ids) =>
        ids.map((id) => ({ contactPhoneId: id, phone: "+15555550101", callable: false, reasons: ["timezone_unresolved"] })),
      placeCall,
    };
    const r = await runDialTick(prisma, session(), deps);
    expect(placeCall).not.toHaveBeenCalled();
    expect(r.blocked).toBe(1);
  });
});

describe("runDialTick — stale queue proceeds", () => {
  it("stale:true queue still dials (real queueClient parses + warns)", async () => {
    const placeCall = vi.fn().mockResolvedValue({ callId: "c", providerCallSid: "s" });
    const stalePayload = {
      view: { id: "v", name: "V" },
      leads: [lead({ primaryPhoneId: "cph_stale" })],
      stale: true,
      staleReason: "ranker 20m late",
      generatedAt: "2026-01-01T00:00:00Z",
    };
    const deps: DialTickDeps = {
      getQueue: (viewId, limit) => getQueue({ baseUrl: "http://mock", fetchImpl: jsonFetch(200, stalePayload) }, viewId, limit),
      checkCallable: allCallable,
      placeCall,
    };
    const r = await runDialTick(prisma, session({ lineCount: 1 }), deps);
    expect(r.placed).toBe(1);
    expect(placeCall).toHaveBeenCalledOnce();
  });
});

describe("runDialTick — unknown reason code still fail-closed", () => {
  it("C returns callable:false with an unknown reason → blocked (real compliance parse)", async () => {
    const placeCall = vi.fn();
    const body = {
      results: [{ contactPhoneId: "cph_unk", phone: "+15555550101", callable: false, reasons: ["totally_new_code"] }],
    };
    const deps: DialTickDeps = {
      getQueue: async () => ({
        view: { id: "v", name: "V" },
        leads: [lead({ primaryPhoneId: "cph_unk" })],
        generatedAt: "2026-01-01T00:00:00Z",
      }),
      checkCallable: (ids) => checkCallable({ baseUrl: "http://mock", fetchImpl: jsonFetch(200, body) }, ids),
      placeCall,
    };
    const r = await runDialTick(prisma, session(), deps);
    expect(placeCall).not.toHaveBeenCalled();
    expect(r.blocked).toBe(1);
  });
});
