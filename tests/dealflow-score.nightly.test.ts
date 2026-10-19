import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createHash } from "node:crypto";
import type { PrismaClient } from "@prisma/client";
import { prismaPerf } from "./setup/pg";
import { makeOrg, dropOrg, makeLead } from "./setup/b45";
import { scoreNextChunk, type ScoreChunkResult } from "@/lib/core-data/dealflow-score/driver";
import { getImportSummary } from "@/lib/core-data/importer/summary";

// Brief 50 PR 7 (open item 6.12): an upload ranked while DealFlow's 5:00 am
// run may be going is ranked once more after that run has certainly ended.
//
// Why: DealFlow's run copies the CRM's leads first. People uploaded after
// that copy aren't in it, so the run marks them removed, deletes the matches
// the upload's ranking just made (their DealFlow links go dead), and leaves
// them off the call list; the 7:00 copy then shows them "not ranked" until
// the next morning. A run that missed them started before the upload
// finished, and Vercel stops a run after 5 minutes, so 7 minutes after the
// upload finished (2 for clocks) every such run is over. Asking DealFlow
// again then repairs them: it copies them back, scores them, and the CRM
// writes their rank after the run's call list, which the 7:00 copy keeps.
//
// DealFlow is a stub with PR E's checks (CONTRACT §7) on a fake clock. Real
// Postgres (CI's db-suite), a throwaway organization, made-up people.
const TAG = `b50p7_night_${Date.now()}`;
const BASE = "http://dealflow.test";
const MIN = 60_000;
let db: PrismaClient;
let org: string;
let seq = 0;
let clock = new Date("2026-10-20T09:10:20Z");
const now = () => new Date(clock.getTime());
const at = (iso: string) => (clock = new Date(iso));

const sha256 = (s: string) => createHash("sha256").update(s, "utf8").digest("hex");
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

// An upload that finished at `completedAt`: `n` new people, the last without a Mojo ID (DealFlow can't rank those).
async function seedImport(completedAt: string, n = 5, opts: { lastWithoutMojo?: boolean } = {}) {
  const k = ++seq;
  const done = new Date(completedAt);
  const batch = await db.importBatch.create({
    data: { organizationId: org, userId: "user_test", sourceLabel: TAG, filename: "x.csv", storageKey: "none", status: "completed", createdAt: new Date(done.getTime() - 5 * MIN), completedAt: done },
  });
  const ids: string[] = [];
  for (let i = 0; i < n; i++) {
    const id = `${TAG}_${k}_n${i}`;
    const noMojo = (opts.lastWithoutMojo ?? true) && i === n - 1;
    await makeLead(db, org, { id, displayName: `Test Owner ${k}-${i}`, mojoId: noMojo ? null : `${TAG}_${k}_m${i}`, createdAt: new Date(batch.createdAt.getTime() + MIN) });
    ids.push(id);
  }
  await db.lead.updateMany({ where: { id: { in: ids } }, data: { source: `import:${batch.id}` } });
  return { importId: batch.id, ids: ids.sort(), withMojo: ids.filter((_, i) => !((opts.lastWithoutMojo ?? true) && i === n - 1)) };
}

// DealFlow PR E as the CRM sees it, on the fake clock.
function dealflow(opts: { fail?: () => boolean; notCopied?: Set<string> } = {}) {
  const calls: string[][] = [];
  const fetch = (async (_url: string | URL, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as { importId: string; token: string; leadIds: string[] };
    calls.push(body.leadIds);
    if (opts.fail?.()) return json(500, { error: "scoring_failed" });
    const b = await db.importBatch.findUniqueOrThrow({ where: { id: body.importId } });
    if (b.dealflowScoreTokenHash !== sha256(body.token)) return json(403, { error: "bad_token" });
    if (!b.completedAt || now().getTime() - b.completedAt.getTime() >= 60 * MIN) return json(403, { error: "expired" });
    if (b.dealflowScoredAt) return json(403, { error: "already_scored" });
    const leads = await db.lead.findMany({ where: { id: { in: body.leadIds } }, select: { id: true, mojoId: true } });
    const scored: unknown[] = [];
    const skipped: { crmLeadId: string; reason: string }[] = [];
    for (const l of leads) {
      if (!l.mojoId) skipped.push({ crmLeadId: l.id, reason: "no_mojo_id" });
      else if (opts.notCopied?.has(l.id)) skipped.push({ crmLeadId: l.id, reason: "not_copied" });
      else
        scored.push({
          crmLeadId: l.id, mojoId: l.mojoId, priorityScore: 71, queueReason: "Match: matchFitLift", primaryMatchId: `match_${l.id}_${calls.length}`,
          primaryMatchFit: 84, primaryCaptureStatus: "EXTERNAL_BOTH", primaryMatchConfidence: "HIGH", matchReason: "neighborhood + price",
          contributions: null, buyers: [], notRankedReason: null,
        });
    }
    return json(200, { importId: body.importId, generatedAt: now().toISOString(), includeTestBuyers: true, ms: 3, scored, skipped });
  }) as typeof globalThis.fetch;
  return { fetch, calls };
}

const deps = (fetch: typeof globalThis.fetch) => ({ db, fetch, baseUrl: BASE, chunkSize: 2, now });

// Calls the CRM like the import page: chunk after chunk, until it says done,
// asks to wait, or asks for the retry pass.
async function pass(importId: string, fetch: typeof globalThis.fetch, opts: { after?: string | null; pass?: "retry" } = {}): Promise<ScoreChunkResult> {
  let after = opts.after ?? null;
  for (let i = 0; i < 20; i++) {
    const r = await scoreNextChunk(org, importId, after, deps(fetch), opts.pass ?? "first");
    if (r.done || r.waitMs !== undefined || r.retry || (r.pass === "retry" && opts.pass !== "retry")) return r;
    after = r.next;
  }
  throw new Error("did not finish");
}

const batchRow = (id: string) => db.importBatch.findUniqueOrThrow({ where: { id } });
const synced = async (ids: string[]) =>
  (await db.lead.findMany({ where: { id: { in: ids } }, select: { id: true, dealflowSignalSyncedAt: true }, orderBy: { id: "asc" } })).map((l) => l.dealflowSignalSyncedAt?.toISOString() ?? null);
const sentTimes = (calls: string[][], id: string) => calls.filter((c) => c.includes(id)).length;

beforeAll(async () => {
  db = prismaPerf(2);
  await db.$connect();
  org = await makeOrg(db, TAG);
});

afterAll(async () => {
  if (org) await dropOrg(db, org);
  await db.$disconnect();
});

describe("an upload ranked during DealFlow's 5:00 am run is ranked once more after it ends", () => {
  it("waits (sending nothing) until the run can't still be going, then re-sends the same people once", async () => {
    const s = await seedImport("2026-10-20T09:10:00Z"); // 5:10 am in New York
    const df = dealflow();
    at("2026-10-20T09:10:20Z");
    const first = await pass(s.importId, df.fetch);
    // Everyone was sent and the four with a Mojo ID ranked, but the upload isn't marked done yet.
    expect(first).toMatchObject({ done: false, waitMs: 6 * MIN + 40_000 });
    expect(first.next).toBe(s.ids[s.ids.length - 1]);
    expect(df.calls.flat().sort()).toEqual(s.ids);
    expect((await batchRow(s.importId)).dealflowScoredAt).toBeNull();
    expect(await synced(s.withMojo)).toEqual(s.withMojo.map(() => "2026-10-20T09:10:20.000Z"));
    expect((await getImportSummary(db, org, s.importId, now()))?.scoring?.state).toBe("pending");

    // The page checks back: still waiting, and DealFlow isn't asked anything.
    at("2026-10-20T09:14:00Z");
    expect(await pass(s.importId, df.fetch, { after: first.next })).toMatchObject({ done: false, waitMs: 3 * MIN, next: first.next });
    at("2026-10-20T09:17:00Z");
    expect(await pass(s.importId, df.fetch, { after: first.next })).toMatchObject({ done: false, next: null, pass: "retry" });
    expect(df.calls).toHaveLength(3);

    // The retry pass: only the people ranked during the run, once.
    const second = await pass(s.importId, df.fetch, { pass: "retry" });
    expect(second).toMatchObject({ done: true });
    expect(second.error).toBeUndefined();
    expect(df.calls.slice(3).flat().sort()).toEqual([...s.withMojo].sort());
    expect(await synced(s.withMojo)).toEqual(s.withMojo.map(() => "2026-10-20T09:17:00.000Z"));
    const b = await batchRow(s.importId);
    expect(b.dealflowScoredAt?.toISOString()).toBe("2026-10-20T09:17:00.000Z");
    expect(b.dealflowScoreError).toBeNull();
    expect(b.dealflowScoreTokenHash).toBeNull();
    expect((await getImportSummary(db, org, s.importId, now()))?.scoring).toMatchObject({ state: "done", ranked: 4 });

    // Done for good: nothing is sent again.
    at("2026-10-20T09:30:00Z");
    expect(await pass(s.importId, df.fetch)).toMatchObject({ done: true });
    expect(await pass(s.importId, df.fetch, { pass: "retry" })).toMatchObject({ done: true });
    for (const id of s.withMojo) expect(sentTimes(df.calls, id)).toBe(2);
    expect(sentTimes(df.calls, s.ids[s.ids.length - 1])).toBe(1);
  });

  it("outside DealFlow's hour nothing changes: done after one pass", async () => {
    const s = await seedImport("2026-10-20T14:10:00Z");
    const df = dealflow();
    at("2026-10-20T14:10:20Z");
    expect(await pass(s.importId, df.fetch)).toMatchObject({ done: true });
    expect((await batchRow(s.importId)).dealflowScoredAt?.toISOString()).toBe("2026-10-20T14:10:20.000Z");
    expect(df.calls.flat().sort()).toEqual(s.ids);
    // Just before the hour (08:57, ranked 08:57:30) is outside it too.
    const early = await seedImport("2026-10-20T08:57:00Z");
    at("2026-10-20T08:57:30Z");
    expect(await pass(early.importId, df.fetch)).toMatchObject({ done: true });
  });

  it("asking for the retry pass before the run can have ended sends nothing", async () => {
    const s = await seedImport("2026-10-20T09:40:00Z", 3, { lastWithoutMojo: false });
    const df = dealflow();
    at("2026-10-20T09:40:30Z");
    const first = await pass(s.importId, df.fetch);
    expect(first).toMatchObject({ done: false, waitMs: 6 * MIN + 30_000 });
    at("2026-10-20T09:42:00Z");
    expect(await pass(s.importId, df.fetch, { pass: "retry" })).toMatchObject({ done: false, waitMs: 5 * MIN });
    expect(df.calls.flat()).toHaveLength(3);
  });

  it("if DealFlow fails on the retry, the first ranking stays and the page doesn't say it failed", async () => {
    const s = await seedImport("2026-10-20T09:20:00Z", 3, { lastWithoutMojo: false });
    let failing = false;
    const df = dealflow({ fail: () => failing });
    at("2026-10-20T09:20:10Z");
    await pass(s.importId, df.fetch);
    at("2026-10-20T09:27:05Z");
    failing = true;
    const r = await pass(s.importId, df.fetch, { pass: "retry" });
    expect(r).toMatchObject({ done: true });
    expect(r.error).toBeUndefined();
    const b = await batchRow(s.importId);
    expect(b.dealflowScoreError).toBeNull();
    expect(b.dealflowScoredAt?.toISOString()).toBe("2026-10-20T09:27:05.000Z");
    expect(b.dealflowScoreTokenHash).toBeNull();
    expect(await synced(s.withMojo)).toEqual(s.withMojo.map(() => "2026-10-20T09:20:10.000Z"));
    expect((await getImportSummary(db, org, s.importId, now()))?.scoring?.state).toBe("done");
    // Once: no further attempt.
    expect(await pass(s.importId, df.fetch, { pass: "retry" })).toMatchObject({ done: true });
    expect(df.calls).toHaveLength(3); // 2 first-pass chunks + 1 failed retry
  });

  it("someone DealFlow passes over on the retry isn't sent a third time", async () => {
    const s = await seedImport("2026-10-20T09:30:00Z", 4, { lastWithoutMojo: false });
    const notCopied = new Set<string>();
    const df = dealflow({ notCopied });
    at("2026-10-20T09:30:10Z");
    await pass(s.importId, df.fetch);
    notCopied.add(s.ids[1]);
    at("2026-10-20T09:37:00Z");
    expect(await pass(s.importId, df.fetch, { after: s.ids[3] })).toMatchObject({ pass: "retry" });
    expect(await pass(s.importId, df.fetch, { pass: "retry" })).toMatchObject({ done: true });
    at("2026-10-20T09:38:00Z");
    expect(await pass(s.importId, df.fetch)).toMatchObject({ done: true });
    expect(await pass(s.importId, df.fetch, { pass: "retry" })).toMatchObject({ done: true });
    expect(sentTimes(df.calls, s.ids[1])).toBe(2);
  });

  it("a first pass still going when the run must be over goes straight on to the retry, for the people ranked before", async () => {
    const s = await seedImport("2026-10-20T09:50:00Z", 4, { lastWithoutMojo: false });
    const df = dealflow();
    at("2026-10-20T09:50:30Z");
    const one = await scoreNextChunk(org, s.importId, null, deps(df.fetch));
    expect(one).toMatchObject({ done: false, next: s.ids[1] });
    at("2026-10-20T09:57:10Z"); // past 09:57: the rest are ranked after any run that missed them
    const two = await scoreNextChunk(org, s.importId, one.next, deps(df.fetch));
    expect(two).toMatchObject({ done: false, next: null, pass: "retry" });
    expect(await pass(s.importId, df.fetch, { pass: "retry" })).toMatchObject({ done: true });
    expect(df.calls).toEqual([[s.ids[0], s.ids[1]], [s.ids[2], s.ids[3]], [s.ids[0], s.ids[1]]]);
  });

  it("past DealFlow's hour for an upload there is no retry (DealFlow would refuse it)", async () => {
    const s = await seedImport("2026-10-20T09:05:00Z", 2, { lastWithoutMojo: false });
    const df = dealflow();
    at("2026-10-20T09:05:10Z");
    const first = await pass(s.importId, df.fetch);
    expect(first.waitMs).toBeGreaterThan(0);
    at("2026-10-20T10:04:30Z"); // the page was closed until 59½ minutes after the upload
    expect(await pass(s.importId, df.fetch, { after: first.next })).toMatchObject({ done: true });
    expect(df.calls).toHaveLength(1);
    expect((await batchRow(s.importId)).dealflowScoreError).toBeNull();
  });
});
