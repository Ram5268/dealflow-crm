import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import type { PrismaClient } from "@prisma/client";
import { prismaPerf } from "./setup/pg";
import { checkCallable } from "@/lib/telephony/dial-loop/compliance";
import { getQueue } from "@/lib/telephony/dial-loop/queueClient";
import { runDialTick, type DialSessionRow, type DialTickDeps } from "@/lib/telephony/dial-loop/session";

const ORG = "org_dlu_test";
const USER = "user_dlu_test";
let prisma: PrismaClient;

function jsonFetch(status: number, body: unknown): typeof fetch {
  return (async () =>
    new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })) as unknown as typeof fetch;
}

beforeAll(async () => {
  prisma = prismaPerf(4);
  await prisma.$connect();
  await prisma.dialSession.deleteMany({ where: { organizationId: ORG } });
  await prisma.user.deleteMany({ where: { id: USER } });
  await prisma.organization.deleteMany({ where: { id: ORG } });
  await prisma.organization.create({ data: { id: ORG, slug: "org-dlu", name: "DLU" } });
  await prisma.user.create({ data: { id: USER, organizationId: ORG, email: "dlu@test.local", displayName: "DLU" } });
});
afterAll(async () => {
  await prisma.dialSession.deleteMany({ where: { organizationId: ORG } });
  await prisma.user.deleteMany({ where: { id: USER } });
  await prisma.organization.deleteMany({ where: { id: ORG } });
  await prisma.$disconnect();
});

describe("checkCallable (compliance client)", () => {
  it("returns callable results on a good response", async () => {
    const body = { results: [{ contactPhoneId: "cph_1", phone: "+15555550101", callable: true, reasons: [] }] };
    const out = await checkCallable({ baseUrl: "http://m", fetchImpl: jsonFetch(200, body) }, ["cph_1"]);
    expect(out[0].callable).toBe(true);
  });

  it("non-2xx → fail-closed (all callable:false)", async () => {
    const out = await checkCallable({ baseUrl: "http://m", fetchImpl: jsonFetch(500, {}) }, ["cph_1", "cph_2"]);
    expect(out.every((r) => !r.callable)).toBe(true);
    expect(out).toHaveLength(2);
  });

  it("malformed body → fail-closed", async () => {
    const out = await checkCallable({ baseUrl: "http://m", fetchImpl: jsonFetch(200, { nope: true }) }, ["cph_1"]);
    expect(out[0].callable).toBe(false);
  });

  it("empty input → empty output (no fetch)", async () => {
    const fetchImpl = vi.fn();
    const out = await checkCallable({ baseUrl: "http://m", fetchImpl: fetchImpl as unknown as typeof fetch }, []);
    expect(out).toEqual([]);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("chunks batches larger than 100", async () => {
    const fetchImpl = vi.fn(async (_url: string, init: RequestInit) => {
      const ids = JSON.parse(init.body as string).contactPhoneIds as string[];
      return new Response(
        JSON.stringify({ results: ids.map((id) => ({ contactPhoneId: id, phone: "+1", callable: true, reasons: [] })) }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    });
    const ids = Array.from({ length: 150 }, (_, i) => `cph_${i}`);
    const out = await checkCallable({ baseUrl: "http://m", fetchImpl: fetchImpl as unknown as typeof fetch }, ids);
    expect(out).toHaveLength(150);
    expect(fetchImpl).toHaveBeenCalledTimes(2); // 100 + 50
  });
});

describe("getQueue (queue client)", () => {
  it("throws on a non-2xx response", async () => {
    await expect(getQueue({ baseUrl: "http://m", fetchImpl: jsonFetch(503, {}) }, "save_x")).rejects.toThrow(/queue fetch failed/);
  });
});

describe("runDialTick — slot accounting", () => {
  const session: DialSessionRow = {
    id: "dial_dlu",
    organizationId: ORG,
    userId: null,
    method: "power",
    lineCount: 1,
    callerId: "+15555550100",
    sourceValue: "save_x",
    status: "active",
  };

  it("paused/inactive session → no work", async () => {
    const deps = { getQueue: vi.fn(), checkCallable: vi.fn(), placeCall: vi.fn() } as unknown as DialTickDeps;
    const r = await runDialTick(prisma, { ...session, status: "paused" }, deps);
    expect(r).toEqual({ placed: 0, blocked: 0, paused: false });
    expect(deps.getQueue).not.toHaveBeenCalled();
  });

  it("empty queue → pauses the session", async () => {
    const s = await prisma.dialSession.create({
      data: {
        organizationId: ORG,
        userId: USER,
        sourceType: "saved-search",
        sourceValue: "save_x",
        method: "power",
        lineCount: 1,
        callerId: "+15555550100",
        status: "active",
      },
    });

    const placeCall = vi.fn();
    const deps: DialTickDeps = {
      getQueue: async () => ({ view: { id: "v", name: "V" }, leads: [], generatedAt: "2026-01-01T00:00:00Z" }),
      checkCallable: async () => [],
      placeCall,
    };
    const r = await runDialTick(prisma, { ...session, id: s.id }, deps);
    expect(r.paused).toBe(true);
    const reloaded = await prisma.dialSession.findUnique({ where: { id: s.id } });
    expect(reloaded?.status).toBe("paused");
    await prisma.dialSession.delete({ where: { id: s.id } });
  });
});
