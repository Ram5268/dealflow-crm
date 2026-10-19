import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type pg from "pg";
import type { PrismaClient } from "@prisma/client";
import { makePerfPool, perfConnectionString, prismaPerf } from "./setup/pg";
import { makeOrg, dropOrg, makeLead } from "./setup/b45";
import { createFakeDealflow, dropFakeDealflow, fakeDealflowUrl, FakeDealflow } from "./helpers/fake-dealflow";
import { closeDealflowRoPool } from "@/lib/core-data/dealflow-sync/ro-client";
import { buildSignals, fetchDealflowBatch, type DealflowJoinRow } from "@/lib/core-data/dealflow-sync/sync";
import { applySync } from "@/lib/core-data/dealflow-sync/write";
import { runDealflowSync } from "@/lib/core-data/dealflow-sync/run";

// Brief 50 (PR 11): the morning copy's safety (open items 6.10, 6.11), on a
// real Postgres. Suite 1: CI's db-suite job runs this on its throwaway
// Postgres. The CRM side is throwaway organizations in the test database
// (prismaPerf), the DealFlow side a DealFlow-shaped scratch schema in the same
// database (tests/helpers/fake-dealflow.ts), read through the real read-only
// client. Made-up rows only.
//   • DealFlow may hold more than one organization: the copy reads only the
//     one with the CRM organization's slug (both apps name Ryan's
//     "dealflow-ryan"; DealFlow's own CRM sync pairs them the same way).
//   • It writes only into the CRM organization it runs for: another
//     organization's signal with the same Mojo ID is left alone.
//   • A call list that matches no CRM lead, or fewer than half as many as the
//     last morning's list held, writes nothing (engineering precaution).
const TAG = `b50s_${Date.now()}`;
const SCHEMA = `b50_fake_dealflow_${Date.now()}`;
const HOUR = 3_600_000;
let admin: pg.Pool;
let db: PrismaClient;
let fake: FakeDealflow;
let savedEnv: Record<string, string | undefined> = {};
const orgs: string[] = [];

beforeAll(async () => {
  savedEnv = { ...process.env };
  delete process.env.DEALFLOW_SYNC_STUB;
  await closeDealflowRoPool();
  admin = makePerfPool(2);
  await createFakeDealflow(admin, SCHEMA);
  fake = new FakeDealflow(admin, SCHEMA);
  process.env.DATABASE_URL_DEALFLOW_RO = fakeDealflowUrl(perfConnectionString(), SCHEMA);
  db = prismaPerf(2);
  await db.$connect();
});

afterAll(async () => {
  await closeDealflowRoPool();
  for (const key of Object.keys(process.env)) if (!(key in savedEnv)) delete process.env[key];
  Object.assign(process.env, savedEnv);
  for (const o of orgs) await dropOrg(db, o);
  await db?.$disconnect();
  await dropFakeDealflow(admin, SCHEMA);
  await admin?.end();
});

async function crmOrg(suffix: string): Promise<{ id: string; slug: string }> {
  const slug = `${TAG}_${suffix}`;
  const id = await makeOrg(db, slug);
  orgs.push(id);
  return { id, slug };
}

const LEAD_FIELDS = { priorityScore: true, topMatchFit: true, captureStatus: true, matchReason: true, dealflowDeepLink: true, dealflowSignalSyncedAt: true } as const;
// Every DealFlow field of the org's leads, and its signals, as plain data.
const snapshot = async (organizationId: string) =>
  JSON.parse(JSON.stringify({
    leads: await db.lead.findMany({ where: { organizationId }, orderBy: { id: "asc" }, select: { id: true, ...LEAD_FIELDS } }),
    signals: await db.dealFlowDerivedSignal.findMany({ where: { organizationId }, orderBy: { mojoId: "asc" } }),
  })) as { leads: unknown[]; signals: unknown[] };

describe("the morning copy reads only Ryan's organization in DealFlow", () => {
  it("another DealFlow organization's newer call list and nightly are never read", async () => {
    const ours = await fake.org(`${TAG}_read`);
    const other = await fake.org(`${TAG}_read_other`);
    const a = await fake.seller(ours, `${TAG}_ra`, "lead_ra");
    const b = await fake.seller(ours, `${TAG}_rb`, "lead_rb");
    const x = await fake.seller(other, `${TAG}_rx`, "lead_rx");
    const ourRun = await fake.callList(ours, [a, b], new Date(Date.now() - 2 * HOUR));
    await fake.callList(other, [x], new Date(Date.now() - HOUR)); // newer, but not ours
    await fake.nightly(ours, false, new Date(Date.now() - 3 * HOUR));
    await fake.nightly(other, true, new Date(Date.now() - HOUR)); // newer, but not ours

    const batch = await fetchDealflowBatch(`${TAG}_read`);
    expect(batch.rows.map((r) => r.mojo_id)).toEqual([`${TAG}_ra`, `${TAG}_rb`]);
    expect(new Set(batch.rows.map((r) => r.generation_run_id))).toEqual(new Set([ourRun]));
    expect(batch.includeTestBuyers).toBe(false);

    // A slug DealFlow doesn't have reads nothing (the copy then skips as "empty").
    const none = await fetchDealflowBatch(`${TAG}_no_such_org`);
    expect(none.rows).toEqual([]);
    expect(none.includeTestBuyers).toBeNull();
  });
});

const row = (over: Partial<DealflowJoinRow>): DealflowJoinRow => ({
  mojo_id: null, crm_lead_id: null, queue_rank: 1, priority_score: 80, queue_reason: "Top match", primary_match_id: "m_x",
  primary_match_fit: 84, primary_capture_status: "OWN_BUYER_ONLY", primary_match_confidence: "MEDIUM", match_reason: "Brooklyn buyer",
  contactId: "c_x", contributions: {}, generation_run_id: `${TAG}_run`, generated_at: new Date().toISOString(), ...over,
});

describe("the morning copy writes only into the CRM organization it runs for", () => {
  it("another organization's signal with the same Mojo ID, and its leads, are left exactly as they were", async () => {
    const mine = await crmOrg("w_mine");
    const theirs = await crmOrg("w_theirs");
    const myLead = await makeLead(db, mine.id, { displayName: "Test Owner 1", mojoId: `${TAG}_w1` });
    const theirLead = await makeLead(db, theirs.id, { displayName: "Test Owner 2", mojoId: `${TAG}_shared`, priorityScore: 55, topMatchFit: 60, dealflowSignalSyncedAt: new Date(Date.now() - 24 * HOUR) });
    await db.dealFlowDerivedSignal.create({
      data: { organizationId: theirs.id, mojoId: `${TAG}_shared`, queueRank: 4, priorityScore: 55, dealflowRawJson: { crmLeadId: theirLead } },
    });
    const before = await snapshot(theirs.id);

    await applySync(mine.id, buildSignals({
      includeTestBuyers: false,
      rows: [
        row({ mojo_id: `${TAG}_w1`, crm_lead_id: myLead, queue_rank: 1 }),
        row({ mojo_id: `${TAG}_shared`, crm_lead_id: null, queue_rank: 2, priority_score: 99 }),
      ],
    }), db);

    expect(await snapshot(theirs.id)).toEqual(before);
    expect((await db.lead.findUniqueOrThrow({ where: { id: myLead } })).priorityScore).toBe(80);
  });
});

describe("a call list that matches no CRM lead (or too few) writes nothing", () => {
  let org: { id: string; slug: string };
  let dfOrg: string;
  const leads: string[] = [];
  const contacts: string[] = [];

  beforeAll(async () => {
    org = await crmOrg("g");
    dfOrg = await fake.org(org.slug);
    for (let i = 0; i < 4; i += 1) {
      leads.push(await makeLead(db, org.id, { displayName: `Test Owner ${10 + i}`, mojoId: `${TAG}_g${i}` }));
      contacts.push(await fake.seller(dfOrg, `${TAG}_g${i}`, leads[i]));
    }
    await fake.nightly(dfOrg, false, new Date(Date.now() - 6 * HOUR));
  });

  it("a normal morning (every seller on the list is a CRM lead) is copied as before", async () => {
    await fake.callList(dfOrg, contacts, new Date(Date.now() - 5 * HOUR));
    const r = await runDealflowSync(org.id, new Date(), db);
    expect(r.skipped).toBeUndefined();
    expect(r).toMatchObject({ signalsUpserted: 4, leadsUpdated: 4 });
    const ranked = await db.lead.findMany({ where: { id: { in: leads } }, select: { priorityScore: true } });
    expect(ranked.every((l) => l.priorityScore !== null)).toBe(true);
  });

  it("a list whose sellers match no CRM lead: skipped, nothing written, nothing blanked", async () => {
    const strangers = [
      await fake.seller(dfOrg, `${TAG}_s1`, "no_such_lead_1"),
      await fake.seller(dfOrg, `${TAG}_s2`, null),
    ];
    await fake.callList(dfOrg, strangers, new Date(Date.now() - 4 * HOUR));
    const before = await snapshot(org.id);
    const r = await runDealflowSync(org.id, new Date(), db);
    expect(r.skipped).toBe("no_leads_matched");
    expect(r).toMatchObject({ signalsUpserted: 0, signalsRemoved: 0, leadsUpdated: 0, leadsCleared: 0, count: 0, leadsPromoted: 0 });
    expect(await snapshot(org.id)).toEqual(before);
  });

  it("a list matching fewer than half as many leads as the last morning's list held: skipped, nothing written", async () => {
    await fake.callList(dfOrg, [contacts[0]], new Date(Date.now() - 3 * HOUR)); // 1 lead; the last copy held 4
    const before = await snapshot(org.id);
    const r = await runDealflowSync(org.id, new Date(), db);
    expect(r.skipped).toBe("too_few_leads_matched");
    expect(await snapshot(org.id)).toEqual(before);
  });

  it("exactly half as many is still a normal morning: copied, and the leads left off are cleared as before", async () => {
    await fake.callList(dfOrg, [contacts[0], contacts[1]], new Date(Date.now() - 2 * HOUR));
    const r = await runDealflowSync(org.id, new Date(), db);
    expect(r.skipped).toBeUndefined();
    expect(r).toMatchObject({ leadsUpdated: 2, leadsCleared: 2, signalsRemoved: 2 });
  });

  it("the writer itself never blanks every lead for a batch that maps to none (a second line behind the skip)", async () => {
    const own = await crmOrg("backstop");
    const yesterday = new Date(Date.now() - 24 * HOUR);
    for (let i = 0; i < 2; i += 1) {
      await makeLead(db, own.id, { displayName: `Test Owner ${20 + i}`, mojoId: `${TAG}_b${i}`, priorityScore: 70 - i, topMatchFit: 75, dealflowSignalSyncedAt: yesterday });
    }
    const before = await snapshot(own.id);
    const r = await applySync(own.id, buildSignals({
      includeTestBuyers: false,
      rows: [row({ mojo_id: `${TAG}_ghost`, crm_lead_id: "no_such_lead_2", generated_at: new Date().toISOString() })],
    }), db);
    expect(r).toMatchObject({ leadsUpdated: 0, leadsCleared: 0 });
    expect((await snapshot(own.id)).leads).toEqual(before.leads);
  });
});
