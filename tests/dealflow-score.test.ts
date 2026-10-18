import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createHash } from "node:crypto";
import { PrismaClient } from "@prisma/client";
import { perfConnectionString, prismaPerf } from "./setup/pg";
import { makeOrg, dropOrg, makeLead } from "./setup/b45";
import { scoreNextChunk, type ScoreChunkResult } from "@/lib/core-data/dealflow-score/driver";
import { SCORE_ERROR } from "@/lib/core-data/dealflow-score/messages";
import { IMPORT_SCORING_SOURCE } from "@/lib/core-data/dealflow-score/marker";
import { getImportSummary } from "@/lib/core-data/importer/summary";
import { getSidebar } from "@/lib/core-data/lists/sidebar";
import { getRankedPage } from "@/lib/core-data/lists/ranked";
import { rankingTimesSql } from "@/lib/core-data/lists/sql";

// Brief 45 PR F — new people ranked within minutes (CONTRACT §7, CRM side).
// The CRM sends an upload's NEW leads to DealFlow in chunks (≤ 500; 2 here),
// one fresh token per chunk with only its SHA-256 stored, and writes back only
// those leads' fields and signals. It never runs the morning sync's
// drop/clear path, so everyone else's rank and signals stay exactly as they
// were [brief §5.8, the two traps]. When DealFlow is down, refuses, times out
// or answers nonsense, the import stays completed and the reason is recorded:
// the new people wait for the morning update.
//
// DealFlow is a stub that applies PR E's checks (CONTRACT §7) by reading this
// test database: sha256(token) against the stored hash, completed, within the
// hour, not yet scored; then which ids are new leads of the import. Real
// Postgres (CI's db-suite), throwaway organizations, made-up people.
const TAG = `b45f_score_${Date.now()}`;
const BASE = "http://dealflow.test";
const MIN = 60_000;
let db: PrismaClient;
let org: string;
let other: string;
let seq = 0;

const sha256 = (s: string) => createHash("sha256").update(s, "utf8").digest("hex");
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

interface Seeded { importId: string; newIds: string[]; mergedId: string; noMojoId: string }

// An upload that finished 5 minutes ago: `n` new leads (the last one without a
// Mojo ID) and one lead that was already in the CRM (merged: re-stamped source,
// created long before the upload).
async function seedImport(n = 5, opts: { completedMinutesAgo?: number; status?: string } = {}): Promise<Seeded> {
  const k = ++seq;
  const now = Date.now();
  const batch = await db.importBatch.create({
    data: {
      organizationId: org, userId: "user_test", sourceLabel: TAG, filename: "x.csv", storageKey: "none",
      status: opts.status ?? "completed", createdAt: new Date(now - (opts.completedMinutesAgo ?? 5) * MIN - 5 * MIN),
      completedAt: opts.status && opts.status !== "completed" ? null : new Date(now - (opts.completedMinutesAgo ?? 5) * MIN),
    },
  });
  const source = `import:${batch.id}`;
  const newIds: string[] = [];
  for (let i = 0; i < n; i++) {
    const id = `${TAG}_${k}_n${String(i).padStart(2, "0")}`;
    await makeLead(db, org, { id, displayName: `Test Owner ${k}-${i}`, mojoId: i === n - 1 ? null : `${TAG}_${k}_m${i}`, createdAt: new Date(batch.createdAt.getTime() + MIN) });
    newIds.push(id);
  }
  await db.lead.updateMany({ where: { id: { in: newIds } }, data: { source } });
  const mergedId = await makeLead(db, org, { id: `${TAG}_${k}_merged`, displayName: `Test Owner ${k} merged`, mojoId: `${TAG}_${k}_mm`, createdAt: new Date(now - 30 * 86_400_000) });
  await db.lead.update({ where: { id: mergedId }, data: { source } });
  return { importId: batch.id, newIds: [...newIds].sort(), mergedId, noMojoId: newIds[n - 1] };
}

interface StubOptions {
  notCopied?: Set<string>;
  noMatch?: Set<string>;
  answer?: (body: { importId: string; token: string; leadIds: string[] }) => Promise<Response | undefined> | Response | undefined;
}

// DealFlow PR E, as far as the CRM can tell: the checks of CONTRACT §7 (in
// order, each refusal doing nothing), then a score for every new lead with a
// Mojo ID. Reads the test DB only.
function dealflow(opts: StubOptions = {}) {
  const calls: { importId: string; token: string; leadIds: string[]; storedHash: string | null; url: string }[] = [];
  const fetch = (async (url: string | URL, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as { importId: string; token: string; leadIds: string[] };
    const batch = await db.importBatch.findUnique({
      where: { id: body.importId },
      select: { organizationId: true, status: true, completedAt: true, createdAt: true, dealflowScoreTokenHash: true, dealflowScoredAt: true },
    });
    calls.push({ ...body, storedHash: batch?.dealflowScoreTokenHash ?? null, url: String(url) });
    const custom = await opts.answer?.(body);
    if (custom) return custom;
    if (!batch) return json(404, { error: "not_found" });
    if (batch.dealflowScoreTokenHash !== sha256(body.token)) return json(403, { error: "bad_token" });
    if (batch.status !== "completed") return json(403, { error: "not_completed" });
    if (!batch.completedAt || Date.now() - batch.completedAt.getTime() >= 60 * MIN) return json(403, { error: "expired" });
    if (batch.dealflowScoredAt) return json(403, { error: "already_scored" });
    const leads = await db.lead.findMany({ where: { id: { in: body.leadIds }, organizationId: batch.organizationId }, select: { id: true, mojoId: true, source: true, createdAt: true } });
    const byId = new Map(leads.map((l) => [l.id, l]));
    const scored: unknown[] = [];
    const skipped: { crmLeadId: string; reason: string }[] = [];
    body.leadIds.forEach((id, i) => {
      const l = byId.get(id);
      if (!l || l.source !== `import:${body.importId}` || l.createdAt < batch.createdAt) return skipped.push({ crmLeadId: id, reason: "not_new_in_import" });
      if (!l.mojoId) return skipped.push({ crmLeadId: id, reason: "no_mojo_id" });
      if (opts.notCopied?.has(id)) return skipped.push({ crmLeadId: id, reason: "not_copied" });
      if (opts.noMatch?.has(id)) {
        return scored.push({ crmLeadId: id, mojoId: l.mojoId, priorityScore: null, queueReason: null, primaryMatchId: null, primaryMatchFit: null,
          primaryCaptureStatus: null, primaryMatchConfidence: null, matchReason: null, contributions: null, buyers: [], notRankedReason: "no_matches" });
      }
      scored.push({
        crmLeadId: id, mojoId: l.mojoId, priorityScore: 70.4 + i, queueReason: "Match: matchFitLift", primaryMatchId: `match_${id}`,
        primaryMatchFit: 85.2, primaryCaptureStatus: "EXTERNAL_BOTH", primaryMatchConfidence: "HIGH", matchReason: "neighborhood + price",
        contributions: { matchFitLift: 30 },
        buyers: [{ matchId: `match_${id}`, score: 85, tier: "HOT", reasonKeys: ["neighborhood"], captureStatus: "EXTERNAL_BOTH", type: "opportunity",
          name: "Test Agent", brokerage: "Example Realty", neighborhoods: ["Bushwick"], propertyTypes: ["2-Family"], bedsMin: 3, bedsMax: 4,
          priceMin: 1_000_000, priceMax: 2_000_000, buyerArchetype: null, isTestData: true, phone: "+12125550100", email: "agent@example.com" }],
        notRankedReason: null,
      });
    });
    return json(200, { importId: body.importId, generatedAt: new Date().toISOString(), includeTestBuyers: true, ms: 5, scored, skipped });
  }) as typeof globalThis.fetch;
  return { fetch, calls };
}

const deps = (fetch: typeof globalThis.fetch, over: Record<string, unknown> = {}) => ({ db, fetch, baseUrl: BASE, chunkSize: 2, ...over });

async function runToEnd(importId: string, d: ReturnType<typeof deps>): Promise<ScoreChunkResult[]> {
  const out: ScoreChunkResult[] = [];
  let after: string | null = null;
  for (let i = 0; i < 20; i++) {
    const r = await scoreNextChunk(org, importId, after, d);
    out.push(r);
    if (r.done || r.retry) return out;
    after = r.next;
  }
  throw new Error("did not finish");
}

const batchRow = (id: string) => db.importBatch.findUniqueOrThrow({ where: { id } });
const LEAD_FIELDS = { id: true, priorityScore: true, topMatchFit: true, captureStatus: true, matchReason: true, dealflowDeepLink: true, dealflowSignalSyncedAt: true, mojoId: true } as const;
const leadState = (ids: string[]) => db.lead.findMany({ where: { id: { in: ids } }, select: LEAD_FIELDS, orderBy: { id: "asc" } });
// Everything the morning sync owns, for the whole database, except the rows a test expects to change.
async function everythingElse(except: string[]) {
  return {
    leads: await db.lead.findMany({ where: { id: { notIn: except } }, select: LEAD_FIELDS, orderBy: { id: "asc" } }),
    signals: await db.dealFlowDerivedSignal.findMany({ orderBy: { mojoId: "asc" } }),
  };
}

let ranked: { a: string; b: string; foreign: string };

beforeAll(async () => {
  db = prismaPerf(4);
  await db.$connect();
  org = await makeOrg(db, TAG);
  other = await makeOrg(db, `${TAG}_other`);
  // Already ranked by this morning's update: their fields and signals must never move.
  const morning = new Date(Date.now() - 3 * 60 * MIN);
  const generated = new Date(Date.now() - 5 * 60 * MIN);
  ranked = {
    a: await makeLead(db, org, { displayName: "Test Owner A", mojoId: `${TAG}_ma`, priorityScore: 91, topMatchFit: 88, matchReason: "neighborhood", dealflowSignalSyncedAt: morning, createdAt: new Date(Date.now() - 90 * 86_400_000) }),
    b: await makeLead(db, org, { displayName: "Test Owner B", mojoId: `${TAG}_mb`, priorityScore: 40, topMatchFit: 66, matchReason: "price", dealflowSignalSyncedAt: morning, createdAt: new Date(Date.now() - 80 * 86_400_000) }),
    foreign: await makeLead(db, other, { displayName: "Test Owner Elsewhere", mojoId: `${TAG}_mf`, priorityScore: 55, dealflowSignalSyncedAt: morning }),
  };
  for (const [mojoId, organizationId, priorityScore] of [[`${TAG}_ma`, org, 91], [`${TAG}_mb`, org, 40], [`${TAG}_mf`, other, 55]] as const) {
    await db.dealFlowDerivedSignal.create({
      data: { organizationId, mojoId, priorityScore, queueRank: 1, syncedAt: morning, dealflowRawJson: { generatedAt: generated.toISOString(), includeTestBuyers: false, buyers: [] } },
    });
  }
});

afterAll(async () => {
  if (org) await dropOrg(db, org);
  if (other) await dropOrg(db, other);
  await db?.$disconnect();
});

describe("chunks, the cursor and the one-time token [CONTRACT §7]", () => {
  it("sends the new leads in id order, ≤ chunk size, never a lead that was already in the CRM, then marks the import scored", async () => {
    const s = await seedImport(5);
    const { fetch, calls } = dealflow();
    const results = await runToEnd(s.importId, deps(fetch));
    expect(calls.map((c) => c.leadIds)).toEqual([s.newIds.slice(0, 2), s.newIds.slice(2, 4), s.newIds.slice(4)]);
    expect(calls.every((c) => c.url === `${BASE}/api/crm/score-import` && c.importId === s.importId)).toBe(true);
    expect(calls.flatMap((c) => c.leadIds)).not.toContain(s.mergedId);
    expect(results.map((r) => [r.done, r.next, r.remaining])).toEqual([
      [false, s.newIds[1], 3],
      [false, s.newIds[3], 1],
      [true, null, 0],
    ]);
    const b = await batchRow(s.importId);
    expect(b.dealflowScoredAt).toBeInstanceOf(Date);
    expect(b).toMatchObject({ status: "completed", dealflowScoreTokenHash: null, dealflowScoreError: null });
  });

  it("a fresh token per chunk; only its SHA-256 is stored, and only while the chunk is out", async () => {
    const s = await seedImport(5);
    const { fetch, calls } = dealflow();
    await runToEnd(s.importId, deps(fetch));
    const tokens = calls.map((c) => c.token);
    expect(new Set(tokens).size).toBe(tokens.length);
    for (const c of calls) {
      expect(c.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
      expect(c.storedHash).toBe(sha256(c.token)); // what DealFlow checks
    }
    const b = await batchRow(s.importId);
    expect(b.dealflowScoreTokenHash).toBeNull(); // cleared at the end
    const stored = JSON.stringify(b);
    for (const t of tokens) expect(stored).not.toContain(t); // the token itself is never written
  });

  it("the cursor continues where the last chunk stopped, and a fresh page (no cursor) skips people already scored", async () => {
    const s = await seedImport(5);
    const { fetch, calls } = dealflow();
    const first = await scoreNextChunk(org, s.importId, null, deps(fetch));
    expect(first).toMatchObject({ done: false, next: s.newIds[1], scored: 2 });
    // The page was reloaded: it starts again without a cursor.
    const again = await scoreNextChunk(org, s.importId, null, deps(fetch));
    expect(calls[1].leadIds).toEqual(s.newIds.slice(2, 4));
    expect(again).toMatchObject({ done: false, next: s.newIds[3] });
  });

  it("nothing new to rank (everyone was already in the CRM): done at once, DealFlow not called", async () => {
    const s = await seedImport(0);
    const { fetch, calls } = dealflow();
    expect(await scoreNextChunk(org, s.importId, null, deps(fetch))).toMatchObject({ done: true, scored: 0, remaining: 0 });
    expect(calls).toHaveLength(0);
    expect((await batchRow(s.importId)).dealflowScoredAt).toBeInstanceOf(Date);
  });

  it("an import that hasn't finished, or was already scored: done, DealFlow not called, nothing written", async () => {
    const running = await seedImport(2, { status: "importing" });
    const { fetch, calls } = dealflow();
    expect(await scoreNextChunk(org, running.importId, null, deps(fetch))).toMatchObject({ done: true, scored: 0 });
    expect((await batchRow(running.importId)).dealflowScoreTokenHash).toBeNull();
    const done = await seedImport(2);
    await runToEnd(done.importId, deps(fetch));
    const n = calls.length;
    expect(await scoreNextChunk(org, done.importId, null, deps(fetch))).toMatchObject({ done: true });
    expect(calls).toHaveLength(n);
  });

  it("another organization's import is not found", async () => {
    const s = await seedImport(1);
    const { fetch } = dealflow();
    await expect(scoreNextChunk(other, s.importId, null, deps(fetch))).rejects.toMatchObject({ status: 404 });
  });
});

describe("the write-back: only those leads' fields and signals [brief §5.8, the two traps]", () => {
  it("ranked and no-match leads are written; skipped ones are untouched; nobody else's rank or signal moves", async () => {
    const s = await seedImport(5);
    const [ranked0, noMatch, notCopied, ranked3] = s.newIds; // the 5th has no Mojo ID
    const before = await everythingElse([...s.newIds]);
    const skippedBefore = await leadState([notCopied, s.noMojoId]);
    const { fetch } = dealflow({ noMatch: new Set([noMatch]), notCopied: new Set([notCopied]) });
    const t0 = Date.now();
    const results = await runToEnd(s.importId, deps(fetch));

    expect(results.reduce((n, r) => n + r.scored, 0)).toBe(3);
    expect(results.reduce((n, r) => n + r.notRanked, 0)).toBe(1);
    expect(results.reduce((acc, r) => ({ noMojoId: acc.noMojoId + r.skipped.noMojoId, notCopied: acc.notCopied + r.skipped.notCopied, other: acc.other + r.skipped.other }), { noMojoId: 0, notCopied: 0, other: 0 }))
      .toEqual({ noMojoId: 1, notCopied: 1, other: 0 });

    // Nobody else changed: not the morning's ranked leads, not the merged lead, not another org.
    expect(await everythingElse([...s.newIds])).toEqual({ ...before, signals: expect.arrayContaining(before.signals) });
    const signalsNow = await db.dealFlowDerivedSignal.findMany({ orderBy: { mojoId: "asc" } });
    expect(signalsNow.filter((x) => !before.signals.some((y) => y.mojoId === x.mojoId)).map((x) => x.mojoId).sort())
      .toEqual([`${TAG}_${seq}_m0`, `${TAG}_${seq}_m3`].sort()); // only the two ranked new leads got signals

    const [r0, nm, r3] = await leadState([ranked0, noMatch, ranked3]);
    expect(r0).toMatchObject({ priorityScore: 70, topMatchFit: 85, captureStatus: "EXTERNAL_BOTH", matchReason: "neighborhood + price" });
    expect(r0.dealflowDeepLink).toMatch(/\/matches\?m=match_/);
    expect(r0.dealflowSignalSyncedAt!.getTime()).toBeGreaterThanOrEqual(t0 - 1000);
    expect(r3.priorityScore).toBe(71);
    expect(nm).toMatchObject({ priorityScore: null, topMatchFit: null, captureStatus: null, matchReason: null, dealflowDeepLink: null });
    expect(nm.dealflowSignalSyncedAt).toBeInstanceOf(Date); // DealFlow looked: "not ranked: no match"
    expect(await leadState([notCopied, s.noMojoId])).toEqual(skippedBefore); // skipped: untouched

    const signal = await db.dealFlowDerivedSignal.findUniqueOrThrow({ where: { mojoId: `${TAG}_${seq}_m0` } });
    expect(signal).toMatchObject({ organizationId: org, priorityScore: 70, primaryMatchFit: 85, queueRank: null });
    const raw = signal.dealflowRawJson as Record<string, unknown>;
    expect(raw).toMatchObject({ source: IMPORT_SCORING_SOURCE, importId: s.importId, crmLeadId: ranked0, includeTestBuyers: true });
    expect(JSON.stringify(raw)).not.toMatch(/phone|email|5550100/i);

    // The summary page reads the same facts back.
    expect(await getImportSummary(db, org, s.importId)).toMatchObject({
      people: { new: 5, existing: 1, newWithoutMojoId: 1 },
      scoring: { state: "done", error: null, ranked: 2, noMatch: 1, notScored: 1 },
    });
  });

  it("an existing signal row for the Mojo ID keeps the keys this scoring doesn't write (Brief 44's property) [coordination with Brief 44 PR 5]", async () => {
    const s = await seedImport(2); // the first new lead has a Mojo ID
    const mojoId = `${TAG}_${seq}_m0`;
    // A stale row (a reused Mojo ID), with a key only the morning sync writes,
    // and an old batch's time and run id.
    await db.dealFlowDerivedSignal.create({
      data: {
        organizationId: org, mojoId, priorityScore: 10, queueRank: 4, syncedAt: new Date(Date.now() - 2 * 86_400_000),
        dealflowRawJson: {
          property: { beds: 3, note: "made-up" }, buyers: [{ matchId: "old_match" }], crmLeadId: "an_old_lead",
          generatedAt: new Date(Date.now() - 50 * 60 * MIN).toISOString(), generationRunId: "old_run",
        },
      },
    });
    const { fetch } = dealflow();
    await runToEnd(s.importId, deps(fetch));
    const row = await db.dealFlowDerivedSignal.findUniqueOrThrow({ where: { mojoId } });
    expect(row).toMatchObject({ priorityScore: 70, queueRank: null });
    const raw = row.dealflowRawJson as Record<string, unknown>;
    expect(raw).toMatchObject({
      property: { beds: 3, note: "made-up" }, // kept
      source: IMPORT_SCORING_SOURCE, importId: s.importId, crmLeadId: s.newIds[0], // this scoring's keys win
    });
    expect((raw.buyers as { matchId: string }[]).map((b) => b.matchId)).toEqual([`match_${s.newIds[0]}`]);
    // An upload's row never carries a batch's time or run id (CONTRACT §7), not even an old row's.
    expect("generatedAt" in raw).toBe(false);
    expect("generationRunId" in raw).toBe(false);
  });

  it("the morning clocks don't move: the sidebar's 'ranked' time, the ranking cutoff, and an older unscored lead still shows 'scoring…'", async () => {
    const waiting = await makeLead(db, org, { displayName: "Test Owner Waiting", mojoId: `${TAG}_mw`, createdAt: new Date(Date.now() - 60 * MIN) });
    const clocks = async () => {
      const [t] = await db.$queryRaw<{ rankedAt: Date | null; rankingCutoff: Date | null }[]>`SELECT ${rankingTimesSql(org)}`;
      return { sidebar: (await getSidebar(org, db)).allLeads.rankedAt, rankedAt: t.rankedAt?.toISOString(), cutoff: t.rankingCutoff?.toISOString() };
    };
    const stateOf = async (leadId: string) => {
      for (let page = 1; page < 50; page++) {
        const p = await getRankedPage(org, null, { page, callingOn: false }, db);
        const row = p.rows.find((r) => r.leadId === leadId);
        if (row) return row.rankState;
        if (p.rows.length === 0) break;
      }
      throw new Error("lead not found");
    };
    const before = await clocks();
    expect(before.cutoff).toBeTruthy();
    expect(await stateOf(waiting)).toBe("scoring");

    const s = await seedImport(3);
    const { fetch } = dealflow();
    await runToEnd(s.importId, deps(fetch));
    expect(await db.dealFlowDerivedSignal.count({ where: { organizationId: org, dealflowRawJson: { path: ["importId"], equals: s.importId } } })).toBe(2);

    expect(await clocks()).toEqual(before);
    expect(await stateOf(waiting)).toBe("scoring");
    expect(await stateOf(s.newIds[0])).toBe("ranked");
  });
});

describe("when DealFlow can't rank them: the import stays completed and the reason is kept [brief §5.8]", () => {
  const cases: [string, Parameters<typeof dealflow>[0] & { timeoutMs?: number }, string][] = [
    ["refused (403)", { answer: () => json(403, { error: "bad_token" }) }, SCORE_ERROR.refused],
    ["a server error (500)", { answer: () => json(500, { error: "scoring_failed" }) }, SCORE_ERROR.server],
    ["unreachable", { answer: () => Promise.reject(new TypeError("fetch failed")) }, SCORE_ERROR.unreachable],
    ["no answer in time", { answer: () => new Promise<Response>(() => {}), timeoutMs: 300 }, SCORE_ERROR.timeout],
    ["malformed JSON", { answer: () => new Response('{"scored": [', { status: 200 }) }, SCORE_ERROR.unreadable],
  ];
  for (const [what, stub, message] of cases) {
    it(`${what}: "${message}", nothing written, and the next call stops at once`, async () => {
      const s = await seedImport(3);
      const before = await everythingElse([]);
      const { fetch, calls } = dealflow(stub);
      const r = await scoreNextChunk(org, s.importId, null, deps(fetch, stub.timeoutMs ? { timeoutMs: stub.timeoutMs } : {}));
      expect(r).toMatchObject({ done: true, error: message, scored: 0 });
      const b = await batchRow(s.importId);
      expect(b).toMatchObject({ status: "completed", dealflowScoreError: message, dealflowScoreTokenHash: null, dealflowScoredAt: null });
      expect(await everythingElse([])).toEqual(before);
      expect(await scoreNextChunk(org, s.importId, null, deps(fetch))).toMatchObject({ done: true, error: message });
      expect(calls).toHaveLength(1);
      expect(await getImportSummary(db, org, s.importId)).toMatchObject({ scoring: { state: "failed", error: message } });
    });
  }

  it("more than an hour after the upload finished: DealFlow isn't asked; the morning update ranks them", async () => {
    const s = await seedImport(2, { completedMinutesAgo: 61 });
    const { fetch, calls } = dealflow();
    expect(await scoreNextChunk(org, s.importId, null, deps(fetch))).toMatchObject({ done: true, error: SCORE_ERROR.expired });
    expect(calls).toHaveLength(0);
  });

  it("no DealFlow address off Vercel's production deployment: DealFlow isn't asked, and the reason says so [engineering precaution]", async () => {
    const s = await seedImport(2);
    const { fetch, calls } = dealflow();
    expect(await scoreNextChunk(org, s.importId, null, deps(fetch, { baseUrl: null }))).toMatchObject({ done: true, error: SCORE_ERROR.noAddress });
    expect(calls).toHaveLength(0);
  });

  it("an answer the CRM can't save is kept as an error, and nothing half-written stays", async () => {
    const s = await seedImport(3); // the first chunk holds two leads with a Mojo ID
    const before = await leadState(s.newIds);
    const { fetch } = dealflow({
      answer: async (body) => {
        const leads = await db.lead.findMany({ where: { id: { in: body.leadIds }, mojoId: { not: null } }, select: { id: true, mojoId: true }, orderBy: { id: "asc" } });
        // The second score doesn't fit the CRM's column: the whole write-back must roll back.
        const scored = leads.map((l, i) => ({
          crmLeadId: l.id, mojoId: l.mojoId, priorityScore: i === 0 ? 50 : 3e9, queueReason: null, primaryMatchId: null, primaryMatchFit: null,
          primaryCaptureStatus: null, primaryMatchConfidence: null, matchReason: null, contributions: null, buyers: [], notRankedReason: null,
        }));
        expect(scored).toHaveLength(2);
        return json(200, { importId: body.importId, generatedAt: new Date().toISOString(), includeTestBuyers: false, scored, skipped: [] });
      },
    });
    expect(await scoreNextChunk(org, s.importId, null, deps(fetch))).toMatchObject({ done: true, error: SCORE_ERROR.save });
    expect(await leadState(s.newIds)).toEqual(before);
  });
});

describe("speed: the CRM's own part of a full 500-person chunk (logged, not gated)", () => {
  it("one chunk of 500 new people: the CRM side's time and database round trips", async () => {
    const timed = new PrismaClient({ datasourceUrl: new URL(perfConnectionString()).toString(), log: [{ emit: "event", level: "query" }] });
    let queries = 0;
    timed.$on("query", () => { queries++; });
    try {
      const batch = await db.importBatch.create({
        data: { organizationId: org, userId: "user_test", sourceLabel: TAG, filename: "big.csv", storageKey: "none", status: "completed",
          createdAt: new Date(Date.now() - 10 * MIN), completedAt: new Date(Date.now() - 5 * MIN) },
      });
      await db.lead.createMany({
        data: Array.from({ length: 500 }, (_, i) => ({
          id: `${TAG}_big_${String(i).padStart(3, "0")}`, organizationId: org, displayName: `Test Owner Big ${i}`, mojoId: `${TAG}_bigm_${i}`,
          source: `import:${batch.id}`, createdAt: new Date(Date.now() - 9 * MIN),
        })),
      });
      const { fetch } = dealflow();
      const t0 = performance.now();
      const r = await scoreNextChunk(org, batch.id, null, { db: timed, fetch, baseUrl: BASE });
      const ms = Math.round(performance.now() - t0);
      expect(r).toMatchObject({ done: true, scored: 500 });
      // The stub DealFlow reads this database too; only the CRM's own client is counted.
      console.log(`[brief45 F] one 500-lead chunk, CRM side incl. a local stub DealFlow: ${ms} ms, ${queries} CRM queries`);
    } finally {
      await timed.$disconnect();
    }
  });
});

describe("two pages at once (a reload while a chunk is out)", () => {
  it("a request that lost the token to a newer one is retried, not recorded as an error", async () => {
    const s = await seedImport(3);
    const newer = "f".repeat(64);
    const { fetch } = dealflow({
      answer: async (body) => {
        // Another tab stored its own token while this request was on its way.
        await db.importBatch.update({ where: { id: body.importId }, data: { dealflowScoreTokenHash: newer } });
        return json(403, { error: "bad_token" });
      },
    });
    const r = await scoreNextChunk(org, s.importId, null, deps(fetch));
    expect(r).toMatchObject({ done: false, retry: true, next: null, scored: 0 });
    expect(await batchRow(s.importId)).toMatchObject({ dealflowScoreError: null, dealflowScoreTokenHash: newer, dealflowScoredAt: null });
  });
});
