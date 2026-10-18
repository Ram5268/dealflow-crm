import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createHash } from "node:crypto";
import type { PrismaClient } from "@prisma/client";
import { prismaPerf } from "./setup/pg";
import { makeOrg, dropOrg, makeLead } from "./setup/b45";
import { scoreNextChunk, type ScoreChunkResult } from "@/lib/core-data/dealflow-score/driver";
import { applySync } from "@/lib/core-data/dealflow-sync/write";
import { buildSignals, type DealflowJoinRow } from "@/lib/core-data/dealflow-sync/sync";

// Brief 45 PR F (from its independent review): a whole-database check. After an
// import's new leads are scored, every row of every table is byte-identical
// (row_to_json text) except the import's own new leads (their 6 DealFlow
// columns only), their signal rows and the import's ImportBatch row. It pins:
// the Mojo ID check in the write (a wrong Mojo ID in the answer writes
// nothing), answers about leads outside the chunk ignored (a morning lead,
// another import's lead, another org's lead, an unknown id, a duplicate), and
// another organization's signal row with the same Mojo ID left alone; then the
// morning-sync guard on the same data. Made-up data only.
const TAG = `b45f_whole_${Date.now()}`;
const MIN = 60_000;
let db: PrismaClient;
let org: string;
let other: string;
const sha256 = (s: string) => createHash("sha256").update(s, "utf8").digest("hex");
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

async function tables(): Promise<string[]> {
  const rows = await db.$queryRawUnsafe<{ t: string }[]>(
    `SELECT table_name AS t FROM information_schema.tables WHERE table_schema = current_schema() AND table_type = 'BASE TABLE' ORDER BY 1`,
  );
  return rows.map((r) => r.t).filter((t) => t !== "_prisma_migrations");
}
// Every row of every table as text, keyed by table then by the row's id (or the whole row).
async function snapshot(): Promise<Map<string, Map<string, string>>> {
  const out = new Map<string, Map<string, string>>();
  for (const t of await tables()) {
    const rows = await db.$queryRawUnsafe<{ k: string; v: string }[]>(
      `SELECT COALESCE(to_jsonb(x)->>'id', to_jsonb(x)::text) AS k, row_to_json(x)::text AS v FROM "${t}" x`,
    );
    out.set(t, new Map(rows.map((r) => [r.k, r.v])));
  }
  return out;
}

// PR E's answer shape (lib/importScoring/signals.ts toScoredLead): an excluded seller comes back with nulls.
function dealflowLikePrE(opts: { excluded?: Set<string>; notCopied?: Set<string>; wrongMojo?: Set<string>; extra?: (b: { leadIds: string[] }) => unknown[] } = {}) {
  const calls: { leadIds: string[]; token: string }[] = [];
  const fetch = (async (_url: string | URL, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as { importId: string; token: string; leadIds: string[] };
    calls.push({ leadIds: body.leadIds, token: body.token });
    const b = await db.importBatch.findUnique({ where: { id: body.importId } });
    if (!b) return json(404, { error: "not_found" });
    if (b.dealflowScoreTokenHash !== sha256(body.token)) return json(403, { error: "bad_token" });
    if (b.status !== "completed") return json(403, { error: "not_completed" });
    if (!b.completedAt || Date.now() - b.completedAt.getTime() >= 60 * MIN) return json(403, { error: "expired" });
    if (b.dealflowScoredAt) return json(403, { error: "already_scored" });
    const leads = await db.lead.findMany({ where: { id: { in: body.leadIds }, organizationId: b.organizationId, source: `import:${b.id}`, createdAt: { gte: b.createdAt } } });
    const by = new Map(leads.map((l) => [l.id, l]));
    const scored: unknown[] = [];
    const skipped: { crmLeadId: string; reason: string }[] = [];
    for (const id of body.leadIds) {
      const l = by.get(id);
      if (!l) { skipped.push({ crmLeadId: id, reason: "not_new_in_import" }); continue; }
      if (!l.mojoId) { skipped.push({ crmLeadId: id, reason: "no_mojo_id" }); continue; }
      if (opts.notCopied?.has(id)) { skipped.push({ crmLeadId: id, reason: "not_copied" }); continue; }
      if (opts.excluded?.has(id)) {
        scored.push({ crmLeadId: id, mojoId: l.mojoId, priorityScore: null, queueReason: null, primaryMatchId: null, primaryMatchFit: null,
          primaryCaptureStatus: null, primaryMatchConfidence: null, matchReason: null, contributions: null, buyers: [], notRankedReason: "no_matches" });
        continue;
      }
      scored.push({ crmLeadId: id, mojoId: opts.wrongMojo?.has(id) ? `${TAG}_WRONG` : l.mojoId, priorityScore: 61.6, queueReason: "Match: matchFitLift", primaryMatchId: `m_${id}`,
        primaryMatchFit: 77.4, primaryCaptureStatus: "EXTERNAL_BOTH", primaryMatchConfidence: "MEDIUM", matchReason: "neighborhood",
        contributions: { matchFitLift: 12.5 }, buyers: [{ matchId: `m_${id}`, score: 77, tier: "WARM", reasonKeys: ["neighborhood"], captureStatus: "EXTERNAL_BOTH",
          type: "opportunity", name: "Test Agent", brokerage: "Example Realty", neighborhoods: [], propertyTypes: [], bedsMin: null, bedsMax: null,
          priceMin: null, priceMax: null, buyerArchetype: null, isTestData: true }], notRankedReason: null });
    }
    scored.push(...(opts.extra?.({ leadIds: body.leadIds }) ?? []));
    return json(200, { importId: body.importId, generatedAt: new Date().toISOString(), includeTestBuyers: false, ms: 3, scored, skipped });
  }) as typeof globalThis.fetch;
  return { fetch, calls };
}

async function runAll(importId: string, fetch: typeof globalThis.fetch, chunkSize = 3): Promise<ScoreChunkResult[]> {
  const out: ScoreChunkResult[] = [];
  let after: string | null = null;
  for (let i = 0; i < 50; i++) {
    const r = await scoreNextChunk(org, importId, after, { db, fetch, baseUrl: "http://dealflow.test", chunkSize });
    out.push(r);
    if (r.done) return out;
    if (!r.retry) after = r.next;
  }
  throw new Error("did not finish");
}

const DF_COLS = ["priorityScore", "topMatchFit", "captureStatus", "matchReason", "dealflowDeepLink", "dealflowSignalSyncedAt"];
const strip = (rowText: string, cols: string[]) => {
  const o = JSON.parse(rowText) as Record<string, unknown>;
  for (const c of cols) delete o[c];
  return JSON.stringify(o);
};

let ids: Record<string, string> = {};
let importId = "";
let otherImportId = "";
const morning = new Date(Date.now() - 3 * 60 * MIN);
const generated = new Date(Date.now() - 5 * 60 * MIN);

beforeAll(async () => {
  db = prismaPerf(4);
  await db.$connect();
  org = await makeOrg(db, TAG);
  other = await makeOrg(db, `${TAG}_o`);
  // Morning-ranked leads, no-match leads, never-scored leads, in both orgs.
  for (let i = 0; i < 12; i++) {
    const kind = i % 3;
    const id = await makeLead(db, org, {
      displayName: `Test Owner M${i}`, mojoId: `${TAG}_mm${i}`, createdAt: new Date(Date.now() - (100 - i) * 86_400_000),
      ...(kind === 0 ? { priorityScore: 90 - i, topMatchFit: 80, matchReason: "neighborhood", dealflowSignalSyncedAt: morning } : {}),
      ...(kind === 1 ? { dealflowSignalSyncedAt: morning } : {}),
    });
    ids[`m${i}`] = id;
    if (kind === 0) {
      await db.dealFlowDerivedSignal.create({ data: { organizationId: org, mojoId: `${TAG}_mm${i}`, queueRank: i + 1, priorityScore: 90 - i,
        syncedAt: morning, dealflowRawJson: { generatedAt: generated.toISOString(), generationRunId: "run_1", crmLeadId: id, includeTestBuyers: false,
          property: { beds: 3 }, buyers: [{ matchId: `old_${i}`, score: 70 }] } } });
    }
  }
  for (let i = 0; i < 4; i++) {
    const id = await makeLead(db, other, { displayName: `Test Owner X${i}`, mojoId: `${TAG}_xm${i}`, priorityScore: 50 + i, dealflowSignalSyncedAt: morning });
    ids[`x${i}`] = id;
    await db.dealFlowDerivedSignal.create({ data: { organizationId: other, mojoId: `${TAG}_xm${i}`, queueRank: i + 1, priorityScore: 50 + i, syncedAt: morning,
      dealflowRawJson: { generatedAt: generated.toISOString(), crmLeadId: id } } });
  }
  // Another org's signal row whose Mojo ID one of our new leads will carry (a foreign row must never be touched).
  await db.dealFlowDerivedSignal.create({ data: { organizationId: other, mojoId: `${TAG}_n_foreignmojo`, queueRank: 9, priorityScore: 9, syncedAt: morning,
    dealflowRawJson: { generatedAt: generated.toISOString(), note: "other org" } } });

  // Another import (completed) with its own new leads: must stay untouched.
  const ob = await db.importBatch.create({ data: { organizationId: org, userId: "u", sourceLabel: TAG, filename: "o.csv", storageKey: "none",
    status: "completed", createdAt: new Date(Date.now() - 20 * MIN), completedAt: new Date(Date.now() - 15 * MIN) } });
  otherImportId = ob.id;
  for (let i = 0; i < 3; i++) {
    const id = await makeLead(db, org, { displayName: `Test Owner O${i}`, mojoId: `${TAG}_om${i}`, createdAt: new Date(Date.now() - 18 * MIN) });
    await db.lead.update({ where: { id }, data: { source: `import:${ob.id}` } });
    ids[`o${i}`] = id;
  }

  // The import under test: finished 5 minutes ago.
  const b = await db.importBatch.create({ data: { organizationId: org, userId: "u", sourceLabel: TAG, filename: "x.csv", storageKey: "none",
    status: "completed", createdAt: new Date(Date.now() - 12 * MIN), completedAt: new Date(Date.now() - 5 * MIN) } });
  importId = b.id;
  const specs: [string, string | null][] = [
    ["n0", `${TAG}_n0`], ["n1", `${TAG}_n1`], ["n2", null], ["n3", `${TAG}_n3`], ["n4", `${TAG}_n4`],
    ["n5", `${TAG}_n_foreignmojo`], ["n6", `${TAG}_n6`], ["n7", `${TAG}_n7`],
  ];
  for (const [k, mojo] of specs) {
    const id = await makeLead(db, org, { id: `${TAG}_${k}`, displayName: `Test Owner ${k}`, mojoId: mojo, createdAt: new Date(Date.now() - 10 * MIN) });
    await db.lead.update({ where: { id }, data: { source: `import:${b.id}` } });
    ids[k] = id;
  }
  // Two morning-ranked leads merged by this import (re-stamped source, created long before): must stay byte-identical.
  for (const k of ["m0", "m3"]) await db.$executeRawUnsafe(`UPDATE "Lead" SET source = $1 WHERE id = $2`, `import:${b.id}`, ids[k]);
  // n7 reuses a Mojo ID with a stale same-org row (Brief 44's property must survive the merge).
  await db.dealFlowDerivedSignal.create({ data: { organizationId: org, mojoId: `${TAG}_n7`, queueRank: 77, priorityScore: 1, syncedAt: new Date(Date.now() - 2 * 86_400_000),
    dealflowRawJson: { property: { beds: 4, note: "made-up" }, generatedAt: new Date(Date.now() - 50 * 60 * MIN).toISOString(), generationRunId: "old_run" } } });
});

afterAll(async () => {
  await db.dealFlowDerivedSignal.deleteMany({ where: { mojoId: { startsWith: TAG } } });
  if (org) await dropOrg(db, org);
  if (other) await dropOrg(db, other);
  await db?.$disconnect();
});

describe("the whole database is byte-identical after an import is scored, apart from what it should change", () => {
  it("only the import's new leads (6 DealFlow columns), their signal rows and the import's batch row change", async () => {
    const before = await snapshot();
    const n7Before = await db.dealFlowDerivedSignal.findUniqueOrThrow({ where: { mojoId: `${TAG}_n7` } });
    const { fetch, calls } = dealflowLikePrE({
      excluded: new Set([ids.n3]),
      notCopied: new Set([ids.n4]),
      wrongMojo: new Set([ids.n6]),
      // Answers about leads not in the chunk (a morning lead, the other import's lead, another org's lead,
      // an unknown id), a wrong Mojo ID and a duplicate: all must be ignored.
      extra: ({ leadIds }) => [
        ...([[ids.m1, `${TAG}_mm1`], [ids.o0, `${TAG}_om0`], [ids.x0, `${TAG}_xm0`], ["no_such_lead", "whatever"]] as const).map(([crmLeadId, mojoId]) => ({ crmLeadId, mojoId, priorityScore: 99, queueReason: null, primaryMatchId: null,
          primaryMatchFit: 99, primaryCaptureStatus: null, primaryMatchConfidence: null, matchReason: "evil", contributions: null, buyers: [], notRankedReason: null })),
        ...(leadIds.includes(ids.n1) ? [{ crmLeadId: ids.n1, mojoId: `${TAG}_n1`, priorityScore: 5, queueReason: null, primaryMatchId: null, primaryMatchFit: 5,
          primaryCaptureStatus: null, primaryMatchConfidence: null, matchReason: "duplicate, second", contributions: null, buyers: [], notRankedReason: null }] : []),
      ],
    });
    const results = await runAll(importId, fetch, 3);
    expect(results.at(-1)).toMatchObject({ done: true });
    expect(calls.flatMap((c) => c.leadIds).sort()).toEqual(["n0", "n1", "n2", "n3", "n4", "n5", "n6", "n7"].map((k) => ids[k]).sort());
    const after = await snapshot();

    const newIds = new Set(["n0", "n1", "n2", "n3", "n4", "n5", "n6", "n7"].map((k) => ids[k]));
    const changed: string[] = [];
    for (const [t, rows] of before) {
      const now = after.get(t)!;
      for (const [k, v] of rows) {
        const w = now.get(k);
        if (w === v) continue;
        if (t === "Lead" && newIds.has(k) && w !== undefined && strip(w, DF_COLS) === strip(v, DF_COLS)) { changed.push(`Lead:${k}`); continue; }
        if (t === "ImportBatch" && k === importId) { changed.push("ImportBatch:this"); continue; }
        if (t === "DealFlowDerivedSignal" && JSON.parse(v).mojoId === `${TAG}_n7`) { changed.push("Signal:n7"); continue; }
        throw new Error(`UNEXPECTED change in ${t} row ${k}:\n before ${v}\n after  ${w}`);
      }
      for (const k of now.keys()) {
        if (rows.has(k)) continue;
        if (t === "DealFlowDerivedSignal") { changed.push(`SignalNew:${JSON.parse(now.get(k)!).mojoId}`); continue; }
        throw new Error(`UNEXPECTED new row in ${t}: ${now.get(k)}`);
      }
    }
    // The leads written: n0, n1, n5 (ranked), n3 (no match), n7 (ranked). Untouched: n2 (no Mojo ID), n4 (not copied), n6 (answer had the wrong Mojo ID).
    const leadChanges = changed.filter((c) => c.startsWith("Lead:")).map((c) => c.slice(5)).sort();
    expect(leadChanges).toEqual(["n0", "n1", "n3", "n5", "n7"].map((k) => ids[k]).sort());
    // Signal rows: new for n0, n1 (ranked, own org); n5's Mojo ID belongs to another org's row (left alone, no new row); n7 merged.
    expect(changed.filter((c) => c.startsWith("SignalNew:")).map((c) => c.slice(10)).sort()).toEqual([`${TAG}_n0`, `${TAG}_n1`].sort());
    expect((await db.lead.findUniqueOrThrow({ where: { id: ids.n1 } })).priorityScore).toBe(62); // the first answer for a lead wins
    expect(changed).toContain("Signal:n7");
    const n7 = await db.dealFlowDerivedSignal.findUniqueOrThrow({ where: { mojoId: `${TAG}_n7` } });
    expect(n7.id).toBe(n7Before.id);
    expect(n7.dealflowRawJson).toMatchObject({ property: { beds: 4, note: "made-up" }, source: "import-scoring", importId, crmLeadId: ids.n7 });
    // The merged row drops the old batch's generatedAt / generationRunId (CONTRACT §7): an upload's row never carries them.
    expect("generationRunId" in (n7.dealflowRawJson as Record<string, unknown>)).toBe(false);
    expect("generatedAt" in (n7.dealflowRawJson as Record<string, unknown>)).toBe(false);
    const foreign = await db.dealFlowDerivedSignal.findUniqueOrThrow({ where: { mojoId: `${TAG}_n_foreignmojo` } });
    expect(foreign.organizationId).toBe(other);
    const leads = await db.lead.findMany({ where: { id: { in: [...newIds] } }, select: { id: true, priorityScore: true, topMatchFit: true, dealflowSignalSyncedAt: true } });
    const by = new Map(leads.map((l) => [l.id, l]));
    expect(by.get(ids.n0)).toMatchObject({ priorityScore: 62, topMatchFit: 77 });
    expect(by.get(ids.n3)).toMatchObject({ priorityScore: null, topMatchFit: null });
    expect(by.get(ids.n3)!.dealflowSignalSyncedAt).toBeInstanceOf(Date);
    expect(by.get(ids.n2)!.dealflowSignalSyncedAt).toBeNull();
    expect(by.get(ids.n4)!.dealflowSignalSyncedAt).toBeNull();
    const b = await db.importBatch.findUniqueOrThrow({ where: { id: importId } });
    expect(b).toMatchObject({ status: "completed", dealflowScoreTokenHash: null, dealflowScoreError: null });
    expect(b.dealflowScoredAt).toBeInstanceOf(Date);
    console.log(`[brief45 F] byte-identical: ${[...before.values()].reduce((n, m) => n + m.size, 0)} rows in ${before.size} tables compared; changes: ${changed.length}`);
  });

  it("the 7:00 copy of a batch made BEFORE the scoring keeps the import's ranks; a LATER batch that leaves them out clears them", async () => {
    const row = (over: Partial<DealflowJoinRow>): DealflowJoinRow => ({
      mojo_id: null, crm_lead_id: null, queue_rank: 1, priority_score: 80, queue_reason: "Top match", primary_match_id: "m_x", primary_match_fit: 84,
      primary_capture_status: "OWN_BUYER_ONLY", primary_match_confidence: "MEDIUM", match_reason: "Brooklyn buyer", contactId: "c_x", contributions: {},
      generation_run_id: `${TAG}_run`, generated_at: null, ...over,
    });
    // DealFlow's 5:00 list (made before the upload was scored) has only m6.
    const early = new Date(Date.now() - 30 * MIN).toISOString();
    await applySync(org, buildSignals({ includeTestBuyers: false, rows: [row({ mojo_id: `${TAG}_mm6`, crm_lead_id: ids.m6, generated_at: early })] }), db);
    const kept = await db.lead.findUniqueOrThrow({ where: { id: ids.n0 } });
    expect(kept.priorityScore).toBe(62);
    expect(await db.dealFlowDerivedSignal.findUnique({ where: { mojoId: `${TAG}_n0` } })).not.toBeNull();
    // A morning-ranked lead that isn't on the list is cleared as before.
    expect((await db.lead.findUniqueOrThrow({ where: { id: ids.m0 } })).priorityScore).toBeNull();
    // The next list (made after the scoring) leaves n0 out: cleared as usual.
    await applySync(org, buildSignals({ includeTestBuyers: false, rows: [row({ mojo_id: `${TAG}_mm6`, crm_lead_id: ids.m6, generated_at: new Date().toISOString() })] }), db);
    expect((await db.lead.findUniqueOrThrow({ where: { id: ids.n0 } })).priorityScore).toBeNull();
    expect(await db.dealFlowDerivedSignal.findUnique({ where: { mojoId: `${TAG}_n0` } })).toBeNull();
    // Another org's rows are never touched by our org's sync.
    expect(await db.dealFlowDerivedSignal.count({ where: { organizationId: other } })).toBe(5);
  });
});
