import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { PrismaClient } from "@prisma/client";
import { prismaPerf } from "./setup/pg";
import { applySync, TIMEZONE_SOURCE } from "@/lib/core-data/dealflow-sync/write";
import { buildSignals, type DealflowJoinRow } from "@/lib/core-data/dealflow-sync/sync";
import { compile, compileOrderBy } from "@/lib/core-data/query-dsl/compiler";
import { execute } from "@/lib/core-data/query-dsl/executor";
import type { SQuery } from "@/lib/core-data/query-dsl/schema";
import { DEFAULT_VIEW, DEFAULT_VIEW_ID } from "@/lib/core-data/smart-view/defaultView";
import { reviewQuery } from "@/lib/core-data/smart-view/review-list";
import { bestBuyerLookup, getLeadBuyers } from "@/lib/core-data/dealflow-sync/buyer-lookup";
import { getLeadProperty } from "@/lib/core-data/dealflow-sync/property-lookup";
import { rawProperty } from "./unit/helpers/property-fixture";

// Brief 37 — the DealFlow sync writer against the perf DB, inside a throwaway
// organization so no other suite's rows are touched. Proves stale-clearing,
// the two-address timezone rule, the unconfirmed calling window, and that the
// view's ">= 0" filter excludes leads with a NULL priorityScore.
const TAG = `b37_${Date.now()}`;
let db: PrismaClient;
let org: string;
const ids: Record<"a" | "b" | "c" | "d", string> = { a: "", b: "", c: "", d: "" };

async function lead(key: keyof typeof ids, states: { property?: string; mailing?: string }, extra: Record<string, unknown> = {}, tz: string | null = null) {
  const l = await db.lead.create({
    data: {
      organizationId: org,
      displayName: `${TAG} ${key}`,
      mojoId: `${TAG}_${key}`,
      ...extra,
      contacts: { create: { organizationId: org, displayName: `${TAG} ${key}`, timezone: tz } },
    },
  });
  const defs = await db.customFieldDefinition.findMany({ where: { organizationId: org } });
  for (const [name, value] of [["Property State", states.property], ["Mailing State", states.mailing]] as const) {
    if (value === undefined) continue;
    const def = defs.find((d) => d.name === name)!;
    await db.customFieldValue.create({
      data: { organizationId: org, definitionId: def.id, objectType: "lead", objectId: l.id, valueText: value },
    });
  }
  ids[key] = l.id;
}

const row = (over: Partial<DealflowJoinRow>): DealflowJoinRow => ({
  mojo_id: null, crm_lead_id: null, queue_rank: 1, priority_score: 80, queue_reason: "Top match",
  primary_match_id: "m_x", primary_match_fit: 84, primary_capture_status: "OWN_BUYER_ONLY",
  primary_match_confidence: "MEDIUM", match_reason: "Brooklyn buyer", contactId: "c_x", contributions: {},
  generation_run_id: `${TAG}_run`, generated_at: new Date().toISOString(), ...over,
});

beforeAll(async () => {
  db = prismaPerf(2);
  await db.$connect();
  org = (await db.organization.create({ data: { slug: TAG, name: "Brief 37 sync test" } })).id;
  await db.customFieldDefinition.createMany({
    data: ["Property State", "Mailing State"].map((name, i) => ({ organizationId: org, objectType: "lead", name, type: "text", displayOrder: i })),
  });
  await lead("a", { property: "NY", mailing: "nj" }); // in batch by crmLeadId; mailing Eastern → tz
  await lead("b", { property: "NY", mailing: "CA" }); // in batch by mojoId only; mailing Pacific → blank
  await lead("c", { property: "NY" }, { priorityScore: 70, topMatchFit: 71, captureStatus: "X", matchReason: "old", dealflowDeepLink: "old", dealflowSignalSyncedAt: new Date() }); // stale → cleared; no mailing → tz
  await lead("d", { property: "NY", mailing: "NY" }, {}, "America/Chicago"); // untouched; tz never overwritten
  await db.dealFlowDerivedSignal.create({ data: { organizationId: org, mojoId: `${TAG}_c`, dealflowRawJson: {} } });
});

afterAll(async () => {
  if (org) {
    await db.dealFlowDerivedSignal.deleteMany({ where: { organizationId: org } });
    await db.savedView.deleteMany({ where: { organizationId: org } });
    await db.callingWindowConfig.deleteMany({ where: { organizationId: org } });
    await db.lead.deleteMany({ where: { organizationId: org } });
    await db.customFieldDefinition.deleteMany({ where: { organizationId: org } });
    await db.organization.delete({ where: { id: org } });
  }
  await db?.$disconnect();
});

describe("applySync (Brief 37)", () => {
  const batch = () => ({
    includeTestBuyers: true,
    rows: [
      row({ mojo_id: `${TAG}_a`, crm_lead_id: ids.a, queue_rank: 1, priority_score: 83, primary_match_id: "m_a" }),
      row({ mojo_id: `${TAG}_b`, crm_lead_id: null, queue_rank: 2, priority_score: 80, primary_match_fit: 90 }),
      row({ mojo_id: `${TAG}_ghost`, crm_lead_id: "no_such_lead", queue_rank: 3 }), // signal kept, no lead
    ],
  });

  it("writes the batch, clears stale leads and signals, fills timezones, seeds an unconfirmed window", async () => {
    const r = await applySync(org, buildSignals(batch()), db);
    expect(r).toMatchObject({ signalsUpserted: 3, signalsRemoved: 1, leadsUpdated: 2, leadsCleared: 1, timezonesSet: 2, windowSeeded: true });

    const leads = await db.lead.findMany({ where: { organizationId: org }, include: { contacts: true } });
    const by = (k: keyof typeof ids) => leads.find((l) => l.id === ids[k])!;
    expect(by("a")).toMatchObject({ priorityScore: 83, topMatchFit: 84, captureStatus: "OWN_BUYER_ONLY", matchReason: "Brooklyn buyer" });
    expect(by("a").dealflowDeepLink).toMatch(/\/matches\?m=m_a$/);
    expect(by("a").dealflowSignalSyncedAt).toBeTruthy();
    expect(by("b")).toMatchObject({ priorityScore: 80, topMatchFit: 90 }); // mapped by mojoId
    expect(by("c")).toMatchObject({ priorityScore: null, topMatchFit: null, captureStatus: null, matchReason: null, dealflowDeepLink: null, dealflowSignalSyncedAt: null });
    expect(by("d").priorityScore).toBeNull();

    // Two-address rule: NY property + Eastern (or missing) mailing state; blanks only.
    expect(by("a").contacts[0]).toMatchObject({ timezone: "America/New_York", timezoneSource: TIMEZONE_SOURCE });
    expect(by("b").contacts[0].timezone).toBeNull();
    expect(by("c").contacts[0]).toMatchObject({ timezone: "America/New_York", timezoneSource: TIMEZONE_SOURCE });
    expect(by("d").contacts[0]).toMatchObject({ timezone: "America/Chicago", timezoneSource: null });

    const signals = await db.dealFlowDerivedSignal.findMany({ where: { organizationId: org } });
    expect(signals.map((s) => s.mojoId).sort()).toEqual([`${TAG}_a`, `${TAG}_b`, `${TAG}_ghost`]);
    expect(signals[0].dealflowRawJson).toMatchObject({ includeTestBuyers: true, generationRunId: `${TAG}_run` });

    const windows = await db.callingWindowConfig.findMany({ where: { organizationId: org } });
    expect(windows).toHaveLength(1);
    expect(windows[0]).toMatchObject({ timezone: "America/New_York", earliestHour: 9, latestHour: 20, allowedDaysOfWeek: [1, 2, 3, 4, 5], policyConfirmedBy: null, policyConfirmedAt: null });
    expect(await db.savedView.findUnique({ where: { id: DEFAULT_VIEW_ID } })).toBeTruthy();
  });

  it("is idempotent: a re-run changes nothing it already did", async () => {
    const r = await applySync(org, buildSignals(batch()), db);
    expect(r).toMatchObject({ signalsUpserted: 3, signalsRemoved: 0, leadsUpdated: 2, leadsCleared: 0, timezonesSet: 0, windowSeeded: false, viewCreated: false });
  });

  it('the view\'s ">= 0" filter excludes NULL priorityScore (run against Postgres)', async () => {
    const run = async (sQuery: SQuery) =>
      (await execute<{ id: string }>(compile(sQuery, { organizationId: org, customFieldTypes: {} }), db, {
        organizationId: org, selectSql: "lead.id", orderBySql: compileOrderBy(DEFAULT_VIEW.sort),
      })).map((r) => r.id);
    expect(await run(DEFAULT_VIEW.sQuery)).toEqual([ids.a, ids.b]); // c and d have NULL priority
    expect(await run(reviewQuery({ type: "match_all" }))).toEqual([ids.a, ids.b]);
  });
});

describe("matched buyers (Brief 38)", () => {
  const buyer = (matchId: string, score: number) => ({
    matchId, score, tier: "HOT", reasonKeys: ["neighborhood"], captureStatus: "EXTERNAL_BOTH", type: "opportunity",
    name: `Agent ${matchId}`, brokerage: null, neighborhoods: ["Bushwick"], propertyTypes: ["2-Family"], bedsMin: 3,
    bedsMax: null, priceMin: 1_000_000, priceMax: 2_000_000, buyerArchetype: null, isTestData: true,
    phone: "+15550000000", email: "buyer@example.com", // must never reach the CRM
  });

  it("stores each seller's buyers on its signal and reads them back per lead, with no contact details", async () => {
    await applySync(org, buildSignals({
      includeTestBuyers: true,
      rows: [
        row({ mojo_id: `${TAG}_a`, crm_lead_id: ids.a, queue_rank: 1, priority_score: 83, primary_match_id: "m_a", buyers: [buyer("m_a", 95), buyer("m_a2", 90)] }),
        row({ mojo_id: `${TAG}_b`, crm_lead_id: null, queue_rank: 2, priority_score: 80, primary_match_fit: 90, buyers: [buyer("m_b", 90)] }),
        row({ mojo_id: `${TAG}_ghost`, crm_lead_id: "no_such_lead", queue_rank: 3 }),
      ],
    }), db);

    const signal = await db.dealFlowDerivedSignal.findUnique({ where: { mojoId: `${TAG}_a` } });
    expect(JSON.stringify(signal?.dealflowRawJson)).not.toMatch(/phone|email|5550000000/i);

    const a = await getLeadBuyers(org, { id: ids.a, mojoId: `${TAG}_a` }, db);
    expect(a.map((b) => [b.matchId, b.name])).toEqual([["m_a", "Agent m_a"], ["m_a2", "Agent m_a2"]]);
    expect(Object.keys(a[0])).not.toContain("phone");
    expect((await getLeadBuyers(org, { id: ids.b, mojoId: `${TAG}_b` }, db)).map((b) => b.matchId)).toEqual(["m_b"]); // by mojoId
    expect(await getLeadBuyers(org, { id: ids.c, mojoId: `${TAG}_c` }, db)).toEqual([]); // not ranked

    const best = await bestBuyerLookup(org, db);
    expect(best({ leadId: ids.a, mojoId: `${TAG}_a` })?.matchId).toBe("m_a");
    expect(best({ leadId: ids.b, mojoId: `${TAG}_b` })?.matchId).toBe("m_b");
    expect(best({ leadId: ids.d, mojoId: `${TAG}_d` })).toBeNull();
  });
});

describe("property value and facts (Brief 44)", () => {
  it("stores each seller's whitelisted property on its signal and reads it back per lead", async () => {
    const property = { ...rawProperty(), ownerName: "Pat Example", bbl: "3999990999" }; // the last two must never reach the CRM
    await applySync(org, buildSignals({
      includeTestBuyers: true,
      rows: [
        row({ mojo_id: `${TAG}_a`, crm_lead_id: ids.a, queue_rank: 1, primary_match_id: "m_a", property }),
        row({ mojo_id: `${TAG}_b`, crm_lead_id: null, queue_rank: 2, property: null }),
      ],
    }), db);

    const signal = await db.dealFlowDerivedSignal.findUnique({ where: { mojoId: `${TAG}_a` } });
    expect(JSON.stringify(signal?.dealflowRawJson)).not.toMatch(/ownerName|Pat Example|bbl|3999990999/);
    expect(await getLeadProperty(org, { id: ids.a, mojoId: `${TAG}_a` }, db)).toEqual(rawProperty());
    expect(await getLeadProperty(org, { id: ids.b, mojoId: `${TAG}_b` }, db)).toBeNull(); // no published valuation
    expect(await getLeadProperty(org, { id: ids.c, mojoId: `${TAG}_c` }, db)).toBeNull(); // not ranked
  });
});
