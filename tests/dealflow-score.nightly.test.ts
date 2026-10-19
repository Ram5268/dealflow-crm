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

// Calls the CRM like the import page: chunk after chunk until it says done.
// With retry: the "is the second ranking due?" ask, then (if it reopened the
// upload) the rest of that pass.
async function pass(importId: string, fetch: typeof globalThis.fetch, opts: { after?: string | null; retry?: true } = {}): Promise<ScoreChunkResult> {
  let after = opts.after ?? null;
  let retry = opts.retry;
  for (let i = 0; i < 20; i++) {
    const r = await scoreNextChunk(org, importId, after, deps(fetch), retry ? { retry } : {});
    if (r.done || r.retry) return r;
    after = r.next;
    retry = undefined;
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
  it("the first ranking ends as before; once the run can't still be going, the same people are ranked once more", async () => {
    const s = await seedImport("2026-10-20T09:10:00Z"); // 5:10 am in New York
    const df = dealflow();
    at("2026-10-20T09:10:20Z");
    const first = await pass(s.importId, df.fetch);
    // Done as before ("Ranked: done"), with when to ask about the second ranking.
    expect(first).toMatchObject({ done: true, waitMs: 6 * MIN + 40_000 });
    expect(first.error).toBeUndefined();
    expect(df.calls.flat().sort()).toEqual(s.ids);
    expect((await batchRow(s.importId)).dealflowScoredAt?.toISOString()).toBe("2026-10-20T09:10:20.000Z");
    expect(await synced(s.withMojo)).toEqual(s.withMojo.map(() => "2026-10-20T09:10:20.000Z"));
    expect((await getImportSummary(db, org, s.importId, now()))?.scoring).toMatchObject({ state: "done", ranked: 4 });

    // Asked early: not yet, and nothing is sent or changed.
    at("2026-10-20T09:14:00Z");
    expect(await pass(s.importId, df.fetch, { retry: true })).toMatchObject({ done: true, waitMs: 3 * MIN });
    expect(df.calls).toHaveLength(3);
    expect((await batchRow(s.importId)).dealflowScoredAt?.toISOString()).toBe("2026-10-20T09:10:20.000Z");

    // 7 minutes after the upload finished: reopened once, and the same people are sent again.
    at("2026-10-20T09:17:00Z");
    const second = await pass(s.importId, df.fetch, { retry: true });
    expect(second).toMatchObject({ done: true });
    expect(second.waitMs).toBeUndefined();
    expect(second.error).toBeUndefined();
    const resent = df.calls.slice(3).flat();
    for (const id of s.withMojo) expect(resent).toContain(id);
    expect(await synced(s.withMojo)).toEqual(s.withMojo.map(() => "2026-10-20T09:17:00.000Z"));
    const b = await batchRow(s.importId);
    expect(b.dealflowScoredAt?.toISOString()).toBe("2026-10-20T09:17:00.000Z");
    expect(b.dealflowScoreError).toBeNull();
    expect(b.dealflowScoreTokenHash).toBeNull();
    expect((await getImportSummary(db, org, s.importId, now()))?.scoring).toMatchObject({ state: "done", ranked: 4 });

    // Once: nothing is sent again, however often the page asks.
    at("2026-10-20T09:30:00Z");
    expect(await pass(s.importId, df.fetch)).toMatchObject({ done: true });
    expect(await pass(s.importId, df.fetch, { retry: true })).toMatchObject({ done: true });
    for (const id of s.withMojo) expect(sentTimes(df.calls, id)).toBe(2);
    // The person without a Mojo ID is never ranked (DealFlow can't), whatever is sent.
    expect((await db.lead.findUniqueOrThrow({ where: { id: s.ids[s.ids.length - 1] } })).dealflowSignalSyncedAt).toBeNull();
  });

  it("outside DealFlow's hour nothing changes: one ranking, nothing owed", async () => {
    const s = await seedImport("2026-10-20T14:10:00Z");
    const df = dealflow();
    at("2026-10-20T14:10:20Z");
    const r = await pass(s.importId, df.fetch);
    expect(r).toMatchObject({ done: true });
    expect(r.waitMs).toBeUndefined();
    expect(df.calls.flat().sort()).toEqual(s.ids);
    at("2026-10-20T14:20:00Z");
    expect(await pass(s.importId, df.fetch, { retry: true })).toMatchObject({ done: true });
    expect(df.calls.flat()).toHaveLength(s.ids.length);
    // Just before the hour (ranked 08:57:30) is outside it too.
    const early = await seedImport("2026-10-20T08:57:00Z");
    at("2026-10-20T08:57:30Z");
    expect((await pass(early.importId, df.fetch)).waitMs).toBeUndefined();
  });

  it("asking about the second ranking while the first is still going does nothing", async () => {
    const s = await seedImport("2026-10-20T09:40:00Z", 4, { lastWithoutMojo: false });
    const df = dealflow();
    at("2026-10-20T09:40:30Z");
    const one = await scoreNextChunk(org, s.importId, null, deps(df.fetch));
    expect(one).toMatchObject({ done: false, next: s.ids[1] });
    expect(await scoreNextChunk(org, s.importId, null, deps(df.fetch), { retry: true })).toMatchObject({ done: true });
    expect(df.calls).toHaveLength(1);
    expect((await batchRow(s.importId)).dealflowScoredAt).toBeNull();
    expect(await pass(s.importId, df.fetch, { after: one.next })).toMatchObject({ done: true, waitMs: 6 * MIN + 30_000 });
  });

  it("if DealFlow fails on the second ranking, the first ranking stays and the page doesn't say it failed", async () => {
    const s = await seedImport("2026-10-20T09:20:00Z", 3, { lastWithoutMojo: false });
    let failing = false;
    const df = dealflow({ fail: () => failing });
    at("2026-10-20T09:20:10Z");
    await pass(s.importId, df.fetch);
    at("2026-10-20T09:27:05Z");
    failing = true;
    const r = await pass(s.importId, df.fetch, { retry: true });
    expect(r).toMatchObject({ done: true });
    expect(r.error).toBeUndefined();
    const b = await batchRow(s.importId);
    expect(b.dealflowScoreError).toBeNull();
    expect(b.dealflowScoredAt?.toISOString()).toBe("2026-10-20T09:27:05.000Z");
    expect(b.dealflowScoreTokenHash).toBeNull();
    expect(await synced(s.withMojo)).toEqual(s.withMojo.map(() => "2026-10-20T09:20:10.000Z"));
    expect((await getImportSummary(db, org, s.importId, now()))?.scoring?.state).toBe("done");
    // Once: no further attempt.
    expect(await pass(s.importId, df.fetch, { retry: true })).toMatchObject({ done: true });
    expect(df.calls).toHaveLength(3); // 2 first-ranking chunks + 1 failed second ranking
  });

  it("someone DealFlow passes over on the second ranking isn't sent a third time", async () => {
    const s = await seedImport("2026-10-20T09:30:00Z", 4, { lastWithoutMojo: false });
    const notCopied = new Set<string>();
    const df = dealflow({ notCopied });
    at("2026-10-20T09:30:10Z");
    await pass(s.importId, df.fetch);
    notCopied.add(s.ids[1]);
    at("2026-10-20T09:37:00Z");
    expect(await pass(s.importId, df.fetch, { retry: true })).toMatchObject({ done: true });
    at("2026-10-20T09:38:00Z");
    expect(await pass(s.importId, df.fetch)).toMatchObject({ done: true });
    expect(await pass(s.importId, df.fetch, { retry: true })).toMatchObject({ done: true });
    expect(sentTimes(df.calls, s.ids[1])).toBe(2);
    expect(sentTimes(df.calls, s.ids[0])).toBe(2);
  });

  it("a page closed during the second ranking: the next visit finishes it, and that is still the only one", async () => {
    const s = await seedImport("2026-10-20T09:45:00Z", 4, { lastWithoutMojo: false });
    const df = dealflow();
    at("2026-10-20T09:45:10Z");
    await pass(s.importId, df.fetch);
    at("2026-10-20T09:52:00Z");
    // Reopened, one chunk sent, then the page went away.
    expect(await scoreNextChunk(org, s.importId, null, deps(df.fetch), { retry: true })).toMatchObject({ done: false, next: s.ids[1] });
    expect((await getImportSummary(db, org, s.importId, now()))?.scoring?.state).toBe("pending");
    // The next visit drives the ranking as usual (the page's first run).
    at("2026-10-20T09:55:00Z");
    expect(await pass(s.importId, df.fetch)).toMatchObject({ done: true });
    expect(df.calls).toEqual([[s.ids[0], s.ids[1]], [s.ids[2], s.ids[3]], [s.ids[0], s.ids[1]], [s.ids[2], s.ids[3]]]);
    expect(await pass(s.importId, df.fetch, { retry: true })).toMatchObject({ done: true });
    expect(df.calls).toHaveLength(4);
  });

  it("past DealFlow's hour for an upload there is no second ranking (DealFlow would refuse it)", async () => {
    const s = await seedImport("2026-10-20T09:05:00Z", 2, { lastWithoutMojo: false });
    const df = dealflow();
    at("2026-10-20T09:05:10Z");
    expect((await pass(s.importId, df.fetch)).waitMs).toBeGreaterThan(0);
    at("2026-10-20T10:04:30Z"); // the page was closed until 59½ minutes after the upload
    const r = await pass(s.importId, df.fetch, { retry: true });
    expect(r).toMatchObject({ done: true });
    expect(r.waitMs).toBeUndefined();
    expect(df.calls).toHaveLength(1);
    expect((await batchRow(s.importId)).dealflowScoreError).toBeNull();
  });

  it("known limit: a first ranking still going 7 minutes after the upload doesn't get the second one", async () => {
    // Only a very big upload (thousands of people) or a slow DealFlow takes that
    // long. People ranked after the 7-minute mark are safe; the earlier ones
    // aren't sent again (nightly.ts, "Not covered").
    const s = await seedImport("2026-10-20T09:50:00Z", 4, { lastWithoutMojo: false });
    const df = dealflow();
    at("2026-10-20T09:50:30Z");
    const one = await scoreNextChunk(org, s.importId, null, deps(df.fetch));
    at("2026-10-20T09:57:10Z");
    const two = await scoreNextChunk(org, s.importId, one.next, deps(df.fetch));
    expect(two).toMatchObject({ done: true });
    expect(two.waitMs).toBeUndefined();
    expect(await pass(s.importId, df.fetch, { retry: true })).toMatchObject({ done: true });
    expect(df.calls).toHaveLength(2);
  });
});
