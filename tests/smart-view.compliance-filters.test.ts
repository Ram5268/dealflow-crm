import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { PrismaClient } from "@prisma/client";
import { prismaPerf } from "./setup/pg";
import { compile, compileOrderBy } from "@/lib/core-data/query-dsl/compiler";
import { execute, executeCount } from "@/lib/core-data/query-dsl/executor";
import type { SQuery } from "@/lib/core-data/query-dsl/schema";
import { listLeads } from "@/lib/leads/list";

// Brief 50 PR 4 (open item 6.4, audit finding L15). The "Do-not-call clean"
// Smart View filter used to compile to TRUE, so a view using it showed
// everyone. Against a real database, inside a throwaway organization with
// made-up people (phones only in 555-0100…0199), a view using it must keep
// exactly the people whose every phone had a clean federal/state do-not-call
// check in the last 24 hours and is on no list the CRM stores. Anything the
// CRM can't vouch for is left out [engineering precaution: fail safe]. And a
// saved view that uses the hidden "Callable now" filter must say so, not
// quietly show everyone.
const TAG = `b50_pr4_${Date.now()}`;
const HOUR = 3_600_000;
let db: PrismaClient;
let org: string;
let otherOrg: string;
const ids: Record<string, string> = {};

const DNC_CLEAN: SQuery = {
  type: "field_condition",
  field: { kind: "compliance", predicate: "dnc_clean" },
  condition: { type: "term", op: "in", values: ["true"] },
};
const CALLABLE_NOW: SQuery = {
  type: "field_condition",
  field: { kind: "compliance", predicate: "callable_now" },
  condition: { type: "term", op: "in", values: ["true"] },
};

// One made-up person: their contacts (each a list of phones) and priority.
async function person(key: string, contacts: { phone: string; smsBlocked?: boolean }[][], priorityScore: number | null = 60) {
  const lead = await db.lead.create({ data: { organizationId: org, displayName: `${TAG} ${key}`, priorityScore } });
  for (const [i, phones] of contacts.entries()) {
    await db.contact.create({
      data: {
        organizationId: org,
        leadId: lead.id,
        displayName: `Test Owner ${key} ${i + 1}`,
        phones: { create: phones.map((p) => ({ phone: p.phone, type: "mobile", outboundSmsBlocked: p.smsBlocked ?? false })) },
      },
    });
  }
  ids[key] = lead.id;
}

// A federal/state registry check, as the compliance engine's vendor step logs it.
const check = (organizationId: string, phone: string, result: "clean" | "blocked" | "error", hoursAgo: number, operation = "check-federal", vendor?: string) =>
  db.scrubLog.create({
    data: { organizationId, phone, operation, result, checkedAt: new Date(Date.now() - hoursAgo * HOUR), ...(vendor ? { detail: { vendor } } : {}) },
  });
const suppress = (organizationId: string, phone: string, source: string) =>
  db.dncSuppression.create({ data: { organizationId, phone, source, addedBy: "test" } });

const KEPT = ["clean", "cleanStateCheck", "twoContactsClean"];

beforeAll(async () => {
  db = prismaPerf(2);
  await db.$connect();
  org = (await db.organization.create({ data: { slug: TAG, name: "Brief 50 PR 4 filter test" } })).id;
  otherOrg = (await db.organization.create({ data: { slug: `${TAG}_other`, name: "Brief 50 PR 4 other org" } })).id;

  // Kept: every phone checked clean within 24 hours, on no stored list.
  await person("clean", [[{ phone: "+12125550154" }]], 90);
  await check(org, "+12125550154", "clean", 1);
  await person("cleanStateCheck", [[{ phone: "+12125550155" }]], 40);
  await check(org, "+12125550155", "clean", 23, "check-state");
  await person("twoContactsClean", [[{ phone: "+12125550156" }], [{ phone: "+12125550157" }]], 70);
  await check(org, "+12125550156", "clean", 2);
  await check(org, "+12125550157", "clean", 3);

  // Left out: on the internal opt-out list (canonical, and two older stored forms).
  await person("optedOut", [[{ phone: "+12125550158" }]]);
  await check(org, "+12125550158", "clean", 1);
  await suppress(org, "+12125550158", "internal");
  await person("optedOut10Digit", [[{ phone: "+12125550159" }]]);
  await check(org, "+12125550159", "clean", 1);
  await suppress(org, "2125550159", "internal");
  await person("optedOut11Digit", [[{ phone: "+12125550161" }]]);
  await check(org, "+12125550161", "clean", 1);
  await suppress(org, "12125550161", "internal");

  // Left out: a stored federal or state registry hit, or a known litigator.
  await person("federalHit", [[{ phone: "+12125550162" }]]);
  await check(org, "+12125550162", "clean", 1);
  await suppress(org, "+12125550162", "federal");
  await person("stateHit", [[{ phone: "+12125550163" }]]);
  await check(org, "+12125550163", "clean", 1);
  await suppress(org, "+12125550163", "state:NY");
  await person("litigator", [[{ phone: "+12125550164" }]]);
  await check(org, "+12125550164", "clean", 1);
  await db.litigatorSuppression.create({ data: { organizationId: org, phone: "+12125550164", vendor: "test" } });

  // Left out: a check in the last 24 hours found it on a list, even with no stored row.
  await person("recentlyBlocked", [[{ phone: "+12125550165" }]]);
  await check(org, "+12125550165", "clean", 3);
  await check(org, "+12125550165", "blocked", 1);

  // Left out: texted STOP.
  await person("textedStop", [[{ phone: "+12125550167", smsBlocked: true }]]);
  await check(org, "+12125550167", "clean", 1);

  // Left out: not known to be clean (never checked, checked too long ago, the
  // check failed, the only clean check belongs to another organization).
  await person("neverChecked", [[{ phone: "+12125550168" }]]);
  await person("staleCheck", [[{ phone: "+12125550169" }]]);
  await check(org, "+12125550169", "clean", 26);
  await person("checkFailed", [[{ phone: "+12125550172" }]]);
  await check(org, "+12125550172", "error", 1);
  // Brief 40 audit H16: a "clean" written by the mock vendor proves nothing.
  await person("mockVendorCheck", [[{ phone: "+12125550177" }]]);
  await check(org, "+12125550177", "clean", 1, "check-federal", "mock");
  await person("otherOrgCheck", [[{ phone: "+12125550173" }]]);
  await check(otherOrg, "+12125550173", "clean", 1);

  // Left out: one clean phone and one opted-out phone on the same person.
  await person("oneBadPhone", [[{ phone: "+12125550174" }, { phone: "+12125550175" }]]);
  await check(org, "+12125550174", "clean", 1);
  await check(org, "+12125550175", "clean", 1);
  await suppress(org, "+12125550175", "internal");

  // Left out: a number that isn't a full US number, even with a clean check.
  await person("unreadable", [[{ phone: "555-0176" }]]);
  await check(org, "555-0176", "clean", 1);

  // Left out: no phone at all.
  await person("contactNoPhone", [[]]);
  await person("noContact", []);
}, 120_000);

afterAll(async () => {
  for (const o of [org, otherOrg].filter(Boolean)) {
    await db.activity.deleteMany({ where: { organizationId: o } });
    await db.scrubLog.deleteMany({ where: { organizationId: o } });
    await db.dncSuppression.deleteMany({ where: { organizationId: o } });
    await db.litigatorSuppression.deleteMany({ where: { organizationId: o } });
    await db.savedView.deleteMany({ where: { organizationId: o } });
    await db.lead.deleteMany({ where: { organizationId: o } });
    await db.organization.delete({ where: { id: o } });
  }
  await db?.$disconnect();
});

const keysOf = (leadIds: string[]) => leadIds.map((id) => Object.keys(ids).find((k) => ids[k] === id) ?? id).sort();

async function run(q: SQuery): Promise<{ keys: string[]; count: number }> {
  const compiled = compile(q, { organizationId: org, customFieldTypes: {} });
  const rows = await execute<{ id: string }>(compiled, db, { organizationId: org, selectSql: "lead.id", orderBySql: compileOrderBy([]) });
  return { keys: keysOf(rows.map((r) => r.id)), count: await executeCount(compiled, db, org) };
}

describe('"Do-not-call clean" Smart View filter (Brief 50 PR 4)', () => {
  it("keeps exactly the people whose every phone had a clean check in the last 24 hours and is on no stored list", async () => {
    const r = await run(DNC_CLEAN);
    expect(r.keys).toEqual([...KEPT].sort());
    expect(r.count).toBe(KEPT.length);
  });

  it("measures the 24 hours in UTC, whatever the database session's time zone", async () => {
    // checkedAt is stored as UTC without a zone; a bare now() would compare it
    // in the session's zone (New York: a 26-hour-old check looks 22 hours old;
    // Tokyo: a 23-hour-old one looks 32 hours old).
    for (const tz of ["America/New_York", "Asia/Tokyo", "UTC"]) {
      const keys = await db.$transaction(async (tx) => {
        await tx.$executeRawUnsafe(`SET LOCAL TIME ZONE '${tz}'`);
        const compiled = compile(DNC_CLEAN, { organizationId: org, customFieldTypes: {} });
        const rows = await execute<{ id: string }>(compiled, tx as unknown as PrismaClient, {
          organizationId: org,
          selectSql: "lead.id",
          orderBySql: compileOrderBy([]),
        });
        return keysOf(rows.map((r) => r.id));
      });
      expect(keys, tz).toEqual([...KEPT].sort());
    }
  });

  it("narrows with other filters (and), and adds to them (or)", async () => {
    const priority60: SQuery = {
      type: "field_condition",
      field: { kind: "regular", table: "lead", column: "priorityScore" },
      condition: { type: "number", op: "gte", value: 60 },
    };
    expect((await run({ type: "and", queries: [DNC_CLEAN, priority60] })).keys).toEqual(["clean", "twoContactsClean"]);
    const neverChecked: SQuery = {
      type: "field_condition",
      field: { kind: "regular", table: "lead", column: "displayName" },
      condition: { type: "text", mode: "exact", value: `${TAG} neverChecked` },
    };
    expect((await run({ type: "or", queries: [DNC_CLEAN, neverChecked] })).keys).toEqual([...KEPT, "neverChecked"].sort());
  });

  it("works through a saved Smart View on the Leads page, with a plain note on what it means", async () => {
    const view = await db.savedView.create({ data: { organizationId: org, name: "Do-not-call clean", type: "lead", sQuery: DNC_CLEAN } });
    const r = await listLeads({ organizationId: org, viewId: view.id, pageSize: 50 }, db);
    expect(r.viewError).toBeUndefined();
    expect(r.total).toBe(KEPT.length);
    expect(keysOf(r.rows.map((x) => x.id))).toEqual([...KEPT].sort());
    expect(r.viewNote).toMatch(/do-not-call/i);
    expect(r.viewNote).toMatch(/24 hours/);
  });

  it("explains itself only when it narrows the list, not as one side of an or", async () => {
    const hot: SQuery = {
      type: "field_condition",
      field: { kind: "regular", table: "lead", column: "statusLabel" },
      condition: { type: "term", op: "in", values: ["Hot"] },
    };
    const view = await db.savedView.create({
      data: { organizationId: org, name: "clean or hot", type: "lead", sQuery: { type: "or", queries: [DNC_CLEAN, hot] } },
    });
    const r = await listLeads({ organizationId: org, viewId: view.id, pageSize: 50 }, db);
    expect(r.viewError).toBeUndefined();
    expect(keysOf(r.rows.map((x) => x.id))).toEqual([...KEPT].sort());
    expect(r.viewNote).toBeUndefined();
  });
});

// Brief 50 PR 4 [engineering precaution]: Ryan's own edit to a lead (Activity
// type 'Edit', written by Brief 50 PR 5) is not activity with the homeowner,
// like a group label's entry ('Group').
describe("Smart View activity filters skip timeline notes", () => {
  it("a lead whose only timeline entries are an edit or a group label has no activity", async () => {
    const at = new Date();
    await db.activity.createMany({
      data: [
        { organizationId: org, leadId: ids.noContact, type: "Edit", activityAt: at, bodyText: "Name changed" },
        { organizationId: org, leadId: ids.contactNoPhone, type: "Group", activityAt: at },
        { organizationId: org, leadId: ids.neverChecked, type: "Call", activityAt: at },
      ],
    });
    expect((await run({ type: "object_type", object_type: "activity" })).keys).toEqual(["neverChecked"]);
  });
});

describe('a saved Smart View that uses the hidden "Callable now" filter', () => {
  it("says the filter isn't available instead of quietly showing everyone as if it applied", async () => {
    const view = await db.savedView.create({
      data: { organizationId: org, name: "Callable now", type: "lead", sQuery: { type: "and", queries: [CALLABLE_NOW] } },
    });
    const r = await listLeads({ organizationId: org, viewId: view.id, pageSize: 50 }, db);
    expect(r.viewError).toMatch(/"Callable now" filter isn't available yet/);
    // The page falls back to all leads under that banner (the existing
    // behavior for a view that can't be applied); it never claims the view ran.
    expect(r.viewNote).toBeUndefined();
  });
});
