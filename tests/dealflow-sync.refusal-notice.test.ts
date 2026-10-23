import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type pg from "pg";
import type { PrismaClient } from "@prisma/client";
import { makePerfPool, perfConnectionString, prismaPerf } from "./setup/pg";
import { makeOrg, dropOrg, makeLead } from "./setup/b45";
import { createFakeDealflow, dropFakeDealflow, fakeDealflowUrl, FakeDealflow } from "./helpers/fake-dealflow";
import { closeDealflowRoPool } from "@/lib/core-data/dealflow-sync/ro-client";
import { buildSignals, fetchDealflowBatch } from "@/lib/core-data/dealflow-sync/sync";
import { countBatchMapping } from "@/lib/core-data/dealflow-sync/write";
import { runDealflowSync } from "@/lib/core-data/dealflow-sync/run";
import { lastScheduledCopy, readCopyRefusal } from "@/lib/core-data/dealflow-sync/nightly-notice";

// Brief 50 (PR 19), the planner's review (Revision 2), on a real Postgres.
// Suite 1: CI's db-suite job runs this on its throwaway Postgres. The CRM side
// is throwaway organizations in the test database (prismaPerf), the DealFlow
// side a DealFlow-shaped scratch schema in the same database
// (tests/helpers/fake-dealflow.ts), read through the real read-only client.
// Made-up rows only.
//   • The copy's size check compares like with like: the leads DealFlow's new
//     list reaches against the leads the last copy reached, not the signal
//     rows it left (engineering precaution, Brief 50 PR 11; the planner's
//     review).
//   • The Queue's line [Ryan's no-babysitting rule, 2026-10-18: checks show up
//     in the product] shows while a refused copy is the newest copy attempt,
//     with N, M and the date of the order the Queue still shows, and a later
//     copy that goes through clears it.
const TAG = `b50r_${Date.now()}`;
const SCHEMA = `b50_fake_dealflow_r_${Date.now()}`;
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
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

// A CRM organization and the DealFlow organization with its slug, `crm` CRM
// sellers (each a CRM lead) and `others` sellers on DealFlow's list who aren't
// CRM leads (DealFlow ranks a few such entries every night).
async function setup(suffix: string, crm: number, others: number) {
  const slug = `${TAG}_${suffix}`;
  const id = await makeOrg(db, slug);
  orgs.push(id);
  const dfOrg = await fake.org(slug);
  const leads: string[] = [];
  const sellers: string[] = [];
  for (let i = 0; i < crm; i += 1) {
    leads.push(await makeLead(db, id, { displayName: `Test Owner ${i + 1}`, mojoId: `${slug}_m${i}` }));
    sellers.push(await fake.seller(dfOrg, `${slug}_m${i}`, leads[i]));
  }
  const strangers: string[] = [];
  for (let i = 0; i < others; i += 1) strangers.push(await fake.seller(dfOrg, `${slug}_x${i}`, null));
  await fake.nightly(dfOrg, false, new Date(Date.now() - 6 * HOUR));
  return { id, slug, dfOrg, leads, sellers, strangers };
}

// DealFlow makes each night's list after the last morning's copy, so every
// list after the first is dated after that copy (minutes ahead of the clock):
// dated before it, the morning-sync guard would spare every lead the copy
// wrote (Brief 45 PR F). See tests/dealflow-sync.safety.test.ts.
const after = (minutes: number) => new Date(Date.now() + minutes * 60_000);

// "This morning", for the Queue's line: half an hour after the first
// scheduled 7:00 copy (11:00 UTC) that comes at least an hour from now. Every
// list below is made before it (so that copy saw it, fresh), and every copy
// below writes before it (on the real clock).
const firstCopyAfter = (t: number) => {
  const d = new Date(t);
  let s = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), 11);
  while (s < t) s += DAY;
  return s;
};
const thisMorning = new Date(firstCopyAfter(Date.now() + HOUR) + 30 * 60_000);

const nyDate = (d: Date) =>
  new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", month: "short", day: "numeric" }).format(d);

describe("the copy's size check compares like with like", () => {
  it("the baseline is the leads the last copy reached, not the signal rows it left", async () => {
    // The last copy: 3 CRM sellers and 3 others, so 6 signal rows reaching 3 leads.
    const o = await setup("base", 3, 3);
    await fake.callList(o.dfOrg, [...o.sellers, ...o.strangers], after(1));
    const first = await runDealflowSync(o.id, after(10), db);
    expect(first).toMatchObject({ signalsUpserted: 6, leadsUpdated: 3 });
    expect(first.skipped).toBeUndefined();

    // Tonight's list reaches 2 of those 3 leads (plus the 3 others): 2 of the
    // usual 3 is more than half. Against the 6 signal rows it would be refused.
    await fake.callList(o.dfOrg, [o.sellers[0], o.sellers[1], ...o.strangers], after(2));
    const batch = await fetchDealflowBatch(o.slug, after(10));
    expect(await countBatchMapping(o.id, buildSignals(batch), db)).toEqual({ mappedLeads: 2, lastCopyLeads: 3 });
    const second = await runDealflowSync(o.id, after(10), db);
    expect(second.skipped).toBeUndefined();
    expect(second).toMatchObject({ leadsUpdated: 2, leadsCleared: 1 });

    // And the next baseline is the 2 leads this copy reached.
    await fake.callList(o.dfOrg, [o.sellers[0]], after(3));
    const next = await fetchDealflowBatch(o.slug, after(10));
    expect(await countBatchMapping(o.id, buildSignals(next), db)).toEqual({ mappedLeads: 1, lastCopyLeads: 2 });
  });

  it("the first copy (nothing before it) is still taken whatever its size, and one that matches nobody is still refused", async () => {
    const o = await setup("first", 2, 1);
    await fake.callList(o.dfOrg, [o.strangers[0]], after(1));
    expect((await runDealflowSync(o.id, after(10), db)).skipped).toBe("no_leads_matched");
    // No earlier copy: nothing for the Queue to "still show", so no line.
    expect(await readCopyRefusal(o.id, { now: thisMorning, db })).toBeNull();

    await fake.callList(o.dfOrg, [o.sellers[0]], after(2));
    const r = await runDealflowSync(o.id, after(10), db);
    expect(r.skipped).toBeUndefined();
    expect(r.leadsUpdated).toBe(1);
  });
});

describe("the Queue's line while a refused copy is the newest copy attempt", () => {
  let o: Awaited<ReturnType<typeof setup>>;
  let copiedAt: Date;
  let copiedOn: string;

  beforeAll(async () => {
    // Yesterday's copy: 4 CRM sellers and 2 others.
    o = await setup("q", 4, 2);
    await fake.callList(o.dfOrg, [...o.sellers, ...o.strangers], after(1));
    const r = await runDealflowSync(o.id, after(10), db);
    expect(r.skipped).toBeUndefined();
    const [last] = await db.dealFlowDerivedSignal.findMany({ where: { organizationId: o.id }, orderBy: { syncedAt: "desc" }, take: 1 });
    copiedAt = last.syncedAt;
    copiedOn = nyDate(copiedAt);
  });

  it("a copy that went through: no line", async () => {
    expect(await readCopyRefusal(o.id, { now: thisMorning, db })).toBeNull();
  });

  it("too few: the cron refuses it, and the line gives N, M and the date of the order the Queue still shows", async () => {
    await fake.callList(o.dfOrg, [o.sellers[0], ...o.strangers], after(2));
    expect((await runDealflowSync(o.id, after(10), db)).skipped).toBe("too_few_leads_matched");
    expect(await readCopyRefusal(o.id, { now: thisMorning, db })).toBe(
      `This morning's ranking from DealFlow looked wrong (it reached 1 of your usual 4 sellers), so the Queue still shows ${copiedOn}'s order.`,
    );
  });

  it("not before the copy has had its chance (between DealFlow's new list and 7:00): no line", async () => {
    // On the real clock the last scheduled copy came before "yesterday's" copy here.
    expect(lastScheduledCopy(new Date()).getTime()).toBeLessThanOrEqual(copiedAt.getTime());
    expect(await readCopyRefusal(o.id, { now: new Date(), db })).toBeNull();
  });

  it("a list already too old when the copy ran (skipped as stale, not as wrong): no line", async () => {
    const listMade = Date.now() + 2 * 60_000;
    const muchLater = new Date(firstCopyAfter(listMade + 36 * HOUR + 60_000) + 30 * 60_000);
    expect((await runDealflowSync(o.id, muchLater, db)).skipped).toBe("stale");
    expect(await readCopyRefusal(o.id, { now: muchLater, db })).toBeNull();
  });

  it("matches nobody: N is 0", async () => {
    await fake.callList(o.dfOrg, o.strangers, after(3));
    expect((await runDealflowSync(o.id, after(10), db)).skipped).toBe("no_leads_matched");
    expect(await readCopyRefusal(o.id, { now: thisMorning, db })).toBe(
      `This morning's ranking from DealFlow looked wrong (it reached 0 of your usual 4 sellers), so the Queue still shows ${copiedOn}'s order.`,
    );
  });

  it("a later copy that goes through clears it", async () => {
    await fake.callList(o.dfOrg, [...o.sellers, ...o.strangers], after(4));
    const r = await runDealflowSync(o.id, after(10), db);
    expect(r.skipped).toBeUndefined();
    expect(r.leadsUpdated).toBe(4);
    expect(await readCopyRefusal(o.id, { now: thisMorning, db })).toBeNull();
  });
});
