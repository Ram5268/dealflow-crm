import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { PrismaClient } from "@prisma/client";
import { prismaPerf } from "./setup/pg";
import { makeOrg, dropOrg, makeLead } from "./setup/b45";
import { applySync } from "@/lib/core-data/dealflow-sync/write";
import { buildSignals, type DealflowJoinRow } from "@/lib/core-data/dealflow-sync/sync";

// Brief 45 PR F — the morning-sync guard (CONTRACT §7), against a real
// Postgres. DealFlow makes its call list around 5:00 and the CRM copies it at
// 7:00. Someone uploaded in between, and the upload's new people were scored
// at once: the 7:00 copy (which treats DealFlow's list as complete and clears
// everyone missing from it) must keep what that scoring wrote. A lead whose
// rank was written before DealFlow made the list is cleared as today.
const TAG = `b45f_guard_${Date.now()}`;
const HOUR = 3_600_000;
let db: PrismaClient;
let org: string;

const row = (over: Partial<DealflowJoinRow>): DealflowJoinRow => ({
  mojo_id: null, crm_lead_id: null, queue_rank: 1, priority_score: 80, queue_reason: "Top match", primary_match_id: "m_x",
  primary_match_fit: 84, primary_capture_status: "OWN_BUYER_ONLY", primary_match_confidence: "MEDIUM", match_reason: "Brooklyn buyer",
  contactId: "c_x", contributions: {}, generation_run_id: `${TAG}_run`, generated_at: null, ...over,
});
const ranked = { priorityScore: 77, topMatchFit: 81, matchReason: "neighborhood" };
const fields = (id: string) =>
  db.lead.findUniqueOrThrow({ where: { id }, select: { priorityScore: true, topMatchFit: true, captureStatus: true, matchReason: true, dealflowDeepLink: true, dealflowSignalSyncedAt: true } });

beforeAll(async () => {
  db = prismaPerf(2);
  await db.$connect();
  org = await makeOrg(db, TAG);
});

afterAll(async () => {
  if (org) await dropOrg(db, org);
  await db?.$disconnect();
});

describe("the 7:00 copy keeps what an upload's scoring wrote after DealFlow made the list", () => {
  it("scored after the list was made: kept (lead fields and signal); scored before, or never: cleared as today", async () => {
    const generatedAt = new Date(Date.now() - 2 * HOUR); // DealFlow's run
    const after = new Date(generatedAt.getTime() + 30 * 60_000); // an upload scored at 5:30
    const before = new Date(generatedAt.getTime() - 24 * HOUR); // yesterday's copy
    const scoredLater = await makeLead(db, org, { displayName: "Test Owner Later", mojoId: `${TAG}_later`, ...ranked, dealflowSignalSyncedAt: after });
    const scoredEarlier = await makeLead(db, org, { displayName: "Test Owner Earlier", mojoId: `${TAG}_earlier`, ...ranked, dealflowSignalSyncedAt: before });
    const neverStamped = await makeLead(db, org, { displayName: "Test Owner Unstamped", mojoId: `${TAG}_unstamped`, ...ranked, dealflowSignalSyncedAt: null });
    // Written in the very millisecond DealFlow made the list: not "after" it, so cleared as before.
    const tie = await makeLead(db, org, { displayName: "Test Owner Tie", mojoId: `${TAG}_tie`, ...ranked, dealflowSignalSyncedAt: generatedAt });
    const inBatch = await makeLead(db, org, { displayName: "Test Owner Listed", mojoId: `${TAG}_listed` });
    await db.dealFlowDerivedSignal.create({ data: { organizationId: org, mojoId: `${TAG}_later`, priorityScore: 77, syncedAt: after, dealflowRawJson: { source: "import-scoring" } } });
    await db.dealFlowDerivedSignal.create({ data: { organizationId: org, mojoId: `${TAG}_earlier`, priorityScore: 77, syncedAt: before, dealflowRawJson: {} } });
    await db.dealFlowDerivedSignal.create({ data: { organizationId: org, mojoId: `${TAG}_tie`, priorityScore: 77, syncedAt: generatedAt, dealflowRawJson: {} } });
    const keptBefore = await fields(scoredLater);

    const r = await applySync(org, buildSignals({ includeTestBuyers: false, rows: [row({ mojo_id: `${TAG}_listed`, crm_lead_id: inBatch, generated_at: generatedAt.toISOString() })] }), db);
    expect(r).toMatchObject({ signalsUpserted: 1, signalsRemoved: 2, leadsUpdated: 1, leadsCleared: 3 });

    expect(await fields(scoredLater)).toEqual(keptBefore);
    expect(await db.dealFlowDerivedSignal.findUnique({ where: { mojoId: `${TAG}_later` } })).not.toBeNull();
    for (const id of [scoredEarlier, neverStamped, tie]) {
      expect(await fields(id)).toEqual({ priorityScore: null, topMatchFit: null, captureStatus: null, matchReason: null, dealflowDeepLink: null, dealflowSignalSyncedAt: null });
    }
    expect(await db.dealFlowDerivedSignal.findUnique({ where: { mojoId: `${TAG}_earlier` } })).toBeNull();
    expect(await db.dealFlowDerivedSignal.findUnique({ where: { mojoId: `${TAG}_tie` } })).toBeNull();
    expect(await fields(inBatch)).toMatchObject({ priorityScore: 80, topMatchFit: 84 });
  });

  it("the next morning's list (made after that upload) clears it as usual if DealFlow left it out", async () => {
    const lead = await db.lead.findFirstOrThrow({ where: { organizationId: org, mojoId: `${TAG}_later` } });
    const listed = await db.lead.findFirstOrThrow({ where: { organizationId: org, mojoId: `${TAG}_listed` } });
    const r = await applySync(org, buildSignals({ includeTestBuyers: false, rows: [row({ mojo_id: `${TAG}_listed`, crm_lead_id: listed.id, generated_at: new Date().toISOString() })] }), db);
    expect(r).toMatchObject({ leadsCleared: 1, signalsRemoved: 1 });
    expect((await fields(lead.id)).priorityScore).toBeNull();
    expect(await db.dealFlowDerivedSignal.findUnique({ where: { mojoId: `${TAG}_later` } })).toBeNull();
  });
});
