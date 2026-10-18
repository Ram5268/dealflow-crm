import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createHash } from "node:crypto";
import type { PrismaClient } from "@prisma/client";
import { prismaPerf } from "./setup/pg";
import { makeOrg, dropOrg, makeLead } from "./setup/b45";
import { scoreNextChunk } from "@/lib/core-data/dealflow-score/driver";
import { SCORE_ERROR } from "@/lib/core-data/dealflow-score/messages";

// Brief 45 PR F (from its independent review). The write-back is all or
// nothing: the answer's lead fields are valid, but a signal-only field
// (queueReason, used only in the signal row because matchReason is set) holds
// a NUL that jsonb refuses, so the signal upsert fails AFTER the leads update
// succeeded; only a real transaction leaves the leads untouched. And the token
// hash is cleared after every chunk, not only at the end. Made-up data only.
const TAG = `b45f_atomic_${Date.now()}`;
const MIN = 60_000;
let db: PrismaClient;
let org: string;
const sha256 = (s: string) => createHash("sha256").update(s, "utf8").digest("hex");
beforeAll(async () => { db = prismaPerf(2); await db.$connect(); org = await makeOrg(db, TAG); });
afterAll(async () => { if (org) await dropOrg(db, org); await db?.$disconnect(); });

describe("the write-back is all or nothing; the token hash lives for one chunk", () => {
  it("a failure in the signal upsert rolls back the lead fields", async () => {
    const b = await db.importBatch.create({ data: { organizationId: org, userId: "u", sourceLabel: TAG, filename: "x.csv", storageKey: "none",
      status: "completed", createdAt: new Date(Date.now() - 12 * MIN), completedAt: new Date(Date.now() - 5 * MIN) } });
    const ids: string[] = [];
    for (let i = 0; i < 2; i++) {
      const id = await makeLead(db, org, { id: `${TAG}_${i}`, displayName: `Test Owner ${i}`, mojoId: `${TAG}_m${i}`, createdAt: new Date(Date.now() - 10 * MIN) });
      await db.lead.update({ where: { id }, data: { source: `import:${b.id}` } });
      ids.push(id);
    }
    const fetch = (async (_u: string | URL, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { importId: string; token: string; leadIds: string[] };
      const batch = await db.importBatch.findUniqueOrThrow({ where: { id: body.importId } });
      if (batch.dealflowScoreTokenHash !== sha256(body.token)) return new Response('{"error":"bad_token"}', { status: 403 });
      const scored = body.leadIds.map((id, i) => ({ crmLeadId: id, mojoId: `${TAG}_m${i}`, priorityScore: 60, queueReason: "bad\u0000reason", primaryMatchId: `m_${i}`,
        primaryMatchFit: 70, primaryCaptureStatus: "EXTERNAL_BOTH", primaryMatchConfidence: "LOW", matchReason: "neighborhood", contributions: null, buyers: [], notRankedReason: null }));
      return new Response(JSON.stringify({ importId: body.importId, generatedAt: new Date().toISOString(), includeTestBuyers: false, scored, skipped: [] }), { status: 200 });
    }) as typeof globalThis.fetch;
    const r = await scoreNextChunk(org, b.id, null, { db, fetch, baseUrl: "http://dealflow.test" });
    expect(r).toMatchObject({ done: true, error: SCORE_ERROR.save });
    const leads = await db.lead.findMany({ where: { id: { in: ids } }, select: { priorityScore: true, dealflowSignalSyncedAt: true } });
    expect(leads).toEqual([{ priorityScore: null, dealflowSignalSyncedAt: null }, { priorityScore: null, dealflowSignalSyncedAt: null }]);
    expect(await db.dealFlowDerivedSignal.count({ where: { organizationId: org } })).toBe(0);
  });

  it("the hash is cleared after every chunk, not only at the end", async () => {
    const b = await db.importBatch.create({ data: { organizationId: org, userId: "u", sourceLabel: TAG, filename: "y.csv", storageKey: "none",
      status: "completed", createdAt: new Date(Date.now() - 12 * MIN), completedAt: new Date(Date.now() - 5 * MIN) } });
    for (let i = 0; i < 3; i++) {
      const id = await makeLead(db, org, { id: `${TAG}_h${i}`, displayName: `Test Owner H${i}`, mojoId: `${TAG}_hm${i}`, createdAt: new Date(Date.now() - 10 * MIN) });
      await db.lead.update({ where: { id }, data: { source: `import:${b.id}` } });
    }
    const fetch = (async (_u: string | URL, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { importId: string; token: string; leadIds: string[] };
      const batch = await db.importBatch.findUniqueOrThrow({ where: { id: body.importId } });
      if (batch.dealflowScoreTokenHash !== sha256(body.token)) return new Response('{"error":"bad_token"}', { status: 403 });
      return new Response(JSON.stringify({ importId: body.importId, generatedAt: new Date().toISOString(), includeTestBuyers: false, skipped: [],
        scored: body.leadIds.map((id) => ({ crmLeadId: id, mojoId: id.replace("_h", "_hm"), priorityScore: 50, queueReason: null, primaryMatchId: null, primaryMatchFit: null,
          primaryCaptureStatus: null, primaryMatchConfidence: null, matchReason: null, contributions: null, buyers: [], notRankedReason: null })) }), { status: 200 });
    }) as typeof globalThis.fetch;
    const first = await scoreNextChunk(org, b.id, null, { db, fetch, baseUrl: "http://dealflow.test", chunkSize: 2 });
    expect(first).toMatchObject({ done: false, scored: 2 });
    expect((await db.importBatch.findUniqueOrThrow({ where: { id: b.id } })).dealflowScoreTokenHash).toBeNull();
  });
});
