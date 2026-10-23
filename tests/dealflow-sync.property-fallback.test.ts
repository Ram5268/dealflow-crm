import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type pg from "pg";
import type { PrismaClient } from "@prisma/client";
import { makePerfPool, perfConnectionString, prismaPerf } from "./setup/pg";
import { makeOrg, dropOrg, makeLead } from "./setup/b45";
import { createFakeDealflow, dropFakeDealflow, fakeDealflowUrl, FakeDealflow } from "./helpers/fake-dealflow";
import { closeDealflowRoPool } from "@/lib/core-data/dealflow-sync/ro-client";
import { buildSignals, fetchDealflowBatch } from "@/lib/core-data/dealflow-sync/sync";
import { applySync } from "@/lib/core-data/dealflow-sync/write";
import { getLeadProperty } from "@/lib/core-data/dealflow-sync/property-lookup";

// Brief 50 (PR 12), open item 5.7: the lead page's "Property value and facts"
// card for every lead DealFlow has valued, not only the ones on DealFlow's call
// list (8 valued sellers had no card on Oct 19). The card still reads the
// morning copy's stored value first; for a lead that has none there, it reads
// that one seller's newest published valuation from DealFlow (read-only, the
// lead page's 2.5 s cap), whitelisted the same way. Nothing is written, so the
// Queue is unchanged. Values older than 100 days are ignored, as DealFlow's
// matching ignores them (Brief 49 PR 3). On a real Postgres: throwaway CRM
// orgs, and a DealFlow-shaped scratch schema read through the real read-only
// client. Made-up rows only; values stay on Ryan's own screen [Ryan, 2026-10-17].
const TAG = `b50v_${Date.now()}`;
const SCHEMA = `b50_fake_dealflow_v_${Date.now()}`;
const DAY = 86_400_000;
let admin: pg.Pool;
let db: PrismaClient;
let fake: FakeDealflow;
let savedEnv: Record<string, string | undefined> = {};
let org: string; // the CRM organization (slug TAG)
let df: string; // DealFlow's organization with the same slug
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
  org = await makeOrg(db, TAG);
  orgs.push(org);
  df = await fake.org(TAG);
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

const valued = (value: number, asOf = "2026-10-01") => ({ asOf, value, low: Math.round(value * 0.85), high: Math.round(value * 1.15) });
const published = (daysAgo: number, asOf = "2026-10-01") => fake.valuationRun(df, { asOf, publishedAt: new Date(Date.now() - daysAgo * DAY) });
const crmSide = async () =>
  JSON.parse(JSON.stringify({
    leads: await db.lead.findMany({
      where: { organizationId: org }, orderBy: { id: "asc" },
      select: { id: true, priorityScore: true, topMatchFit: true, captureStatus: true, matchReason: true, dealflowDeepLink: true, dealflowSignalSyncedAt: true },
    }),
    signals: await db.dealFlowDerivedSignal.findMany({ where: { organizationId: org }, orderBy: { mojoId: "asc" } }),
  }));

describe("the value card for a valued lead who isn't on DealFlow's call list", () => {
  it("shows DealFlow's newest published value and facts, whitelisted, and writes nothing (the Queue is unchanged)", async () => {
    const id = await makeLead(db, org, { displayName: "Test Owner 30", mojoId: `${TAG}_m30` });
    const contact = await fake.seller(df, `${TAG}_m30`, id);
    const old = await published(40, "2026-09-01");
    await fake.valuation(df, old, contact, valued(1_500_000, "2026-09-01"));
    const run = await published(5);
    // ownerName must never reach the CRM (toPropertyFacts' whitelist); bbl isn't even selected.
    await fake.valuation(df, run, contact, { ...valued(1_800_000), facts: { units: 2, yearBuilt: 1910, ownerName: "Pat Example" } });
    const unpublished = await fake.valuationRun(df, { asOf: "2026-11-01", publishedAt: null, published: false });
    await fake.valuation(df, unpublished, contact, valued(9_000_000, "2026-11-01")); // never shown
    const before = await crmSide();

    const p = await getLeadProperty(org, { id, mojoId: `${TAG}_m30` }, db);
    expect(p).toMatchObject({ asOf: "2026-10-01", value: 1_800_000, low: 1_530_000, high: 2_070_000, reason: null });
    expect(p?.facts).toMatchObject({ units: 2, yearBuilt: 1910 });
    expect(JSON.stringify(p)).not.toMatch(/ownerName|Pat Example|bbl|3999990999/);
    expect(await crmSide()).toEqual(before); // read-only: no signal, no lead field written
    expect((await db.lead.findUniqueOrThrow({ where: { id } })).priorityScore).toBeNull(); // still off the Queue
  });

  it("a seller DealFlow knows only by Mojo ID is found; one DealFlow gave to another lead of the organization is not borrowed", async () => {
    const a = await makeLead(db, org, { displayName: "Test Owner 31", mojoId: `${TAG}_m31` });
    const run = await published(5);
    await fake.valuation(df, run, await fake.seller(df, `${TAG}_m31`, null), valued(1_100_000));
    expect((await getLeadProperty(org, { id: a, mojoId: `${TAG}_m31` }, db))?.value).toBe(1_100_000);

    const b = await makeLead(db, org, { displayName: "Test Owner 32", mojoId: `${TAG}_m32` });
    const other = await makeLead(db, org, { displayName: "Test Owner 33", mojoId: null });
    await fake.valuation(df, run, await fake.seller(df, `${TAG}_m32`, other), valued(1_200_000));
    expect(await getLeadProperty(org, { id: b, mojoId: `${TAG}_m32` }, db)).toBeNull();
    expect((await getLeadProperty(org, { id: other, mojoId: null }, db))?.value).toBe(1_200_000);
  });

  it("another DealFlow organization's valuation is never read", async () => {
    const id = await makeLead(db, org, { displayName: "Test Owner 34", mojoId: `${TAG}_m34` });
    const elsewhere = await fake.org(`${TAG}_elsewhere`);
    const contact = await fake.seller(elsewhere, `${TAG}_m34`, id);
    const run = await fake.valuationRun(elsewhere, { asOf: "2026-10-01", publishedAt: new Date(Date.now() - DAY) });
    await fake.valuation(elsewhere, run, contact, valued(1_300_000));
    expect(await getLeadProperty(org, { id, mojoId: `${TAG}_m34` }, db)).toBeNull();
  });

  it("a value whose run was published more than 100 days ago is ignored, as DealFlow's matching ignores it", async () => {
    const stale = await makeLead(db, org, { displayName: "Test Owner 35", mojoId: `${TAG}_m35` });
    await fake.valuation(df, await published(101, "2026-06-01"), await fake.seller(df, `${TAG}_m35`, stale), valued(1_400_000, "2026-06-01"));
    expect(await getLeadProperty(org, { id: stale, mojoId: `${TAG}_m35` }, db)).toBeNull();

    const recent = await makeLead(db, org, { displayName: "Test Owner 36", mojoId: `${TAG}_m36` });
    await fake.valuation(df, await published(99, "2026-07-01"), await fake.seller(df, `${TAG}_m36`, recent), valued(1_450_000, "2026-07-01"));
    expect(await getLeadProperty(org, { id: recent, mojoId: `${TAG}_m36` }, db)).toMatchObject({ asOf: "2026-07-01", value: 1_450_000 });
  });
});

describe("a lead on the call list keeps the morning copy's stored value", () => {
  it("the stored value is shown, not a fresh read", async () => {
    const id = await makeLead(db, org, { displayName: "Test Owner 37", mojoId: `${TAG}_m37` });
    const contact = await fake.seller(df, `${TAG}_m37`, id);
    await fake.valuation(df, await published(1), contact, valued(2_500_000)); // DealFlow's, not copied yet
    const stored = { ...valued(2_000_000), dataThrough: "2026-09-30", publishedAt: new Date(Date.now() - 2 * DAY).toISOString(), facts: { units: 3 } };
    await applySync(org, buildSignals({
      includeTestBuyers: false,
      rows: [{
        mojo_id: `${TAG}_m37`, crm_lead_id: id, queue_rank: 1, priority_score: 80, queue_reason: "Top match", primary_match_id: null,
        primary_match_fit: 80, primary_capture_status: null, primary_match_confidence: null, match_reason: null, contactId: contact,
        contributions: {}, generation_run_id: `${TAG}_run`, generated_at: new Date().toISOString(), property: stored,
      }],
    }), db);
    expect((await getLeadProperty(org, { id, mojoId: `${TAG}_m37` }, db))?.value).toBe(2_000_000);
  });

  it("a stored value older than 100 days isn't shown; a fresh DealFlow read is tried instead, the same rule the copy uses", async () => {
    const id = await makeLead(db, org, { displayName: "Test Owner 38", mojoId: `${TAG}_m38` });
    const contact = await fake.seller(df, `${TAG}_m38`, id);
    // The morning copy stored this while the seller was still on the call
    // list; it has since dropped off (PR 12's gap) and nothing has refreshed
    // it, so it just sits there getting older.
    const stale = {
      ...valued(2_000_000, "2026-06-01"),
      dataThrough: "2026-05-31",
      publishedAt: new Date(Date.now() - 101 * DAY).toISOString(),
      facts: { units: 3 },
    };
    await applySync(org, buildSignals({
      includeTestBuyers: false,
      rows: [{
        mojo_id: `${TAG}_m38`, crm_lead_id: id, queue_rank: 1, priority_score: 80, queue_reason: "Top match", primary_match_id: null,
        primary_match_fit: 80, primary_capture_status: null, primary_match_confidence: null, match_reason: null, contactId: contact,
        contributions: {}, generation_run_id: `${TAG}_run38`, generated_at: new Date().toISOString(), property: stale,
      }],
    }), db);
    // DealFlow itself has nothing fresher published: the stale stored value
    // must not be shown, so there is no card at all.
    expect(await getLeadProperty(org, { id, mojoId: `${TAG}_m38` }, db)).toBeNull();

    // DealFlow has since published a fresh run for the same seller: the live
    // fallback (PR 12) finds it, same as a lead with no stored value at all.
    const run = await published(5);
    await fake.valuation(df, run, contact, valued(2_100_000));
    expect((await getLeadProperty(org, { id, mojoId: `${TAG}_m38` }, db))?.value).toBe(2_100_000);
  });
});

describe("the morning copy ignores values older than 100 days too", () => {
  it("a call-list seller whose newest published run is 101 days old carries no value", async () => {
    const slug = `${TAG}_copy`;
    orgs.push(await makeOrg(db, slug));
    const dfCopy = await fake.org(slug);
    const fresh = await fake.seller(dfCopy, `${TAG}_c1`, "lead_c1");
    const stale = await fake.seller(dfCopy, `${TAG}_c2`, "lead_c2");
    const newRun = await fake.valuationRun(dfCopy, { asOf: "2026-10-01", publishedAt: new Date(Date.now() - 3 * DAY) });
    const oldRun = await fake.valuationRun(dfCopy, { asOf: "2026-06-01", publishedAt: new Date(Date.now() - 101 * DAY) });
    await fake.valuation(dfCopy, newRun, fresh, valued(1_600_000));
    await fake.valuation(dfCopy, oldRun, stale, valued(1_700_000, "2026-06-01"));
    await fake.callList(dfCopy, [fresh, stale], new Date(Date.now() - 3_600_000));
    const batch = await fetchDealflowBatch(slug);
    const byMojo = new Map(buildSignals(batch).map((s) => [s.mojoId, s.dealflowRawJson.property as { value?: number } | null]));
    expect(byMojo.get(`${TAG}_c1`)?.value).toBe(1_600_000);
    expect(byMojo.get(`${TAG}_c2`)).toBeNull();
  });
});
