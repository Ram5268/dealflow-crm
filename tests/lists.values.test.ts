import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { PrismaClient } from "@prisma/client";
import { prismaPerf, perfConnectionString } from "./setup/pg";
import { makeOrg, dropOrg, makeLead } from "./setup/b45";
import { createList } from "@/lib/core-data/lists/lists";
import { createGroup, addGroupMembers } from "@/lib/core-data/lists/groups";
import { getRankedPage, exportRankedCsv, EXPORT_COLUMNS } from "@/lib/core-data/lists/ranked";
import { getPipeline } from "@/lib/core-data/lists/pipeline";
import { createWorkflow, updateWorkflow } from "@/lib/core-data/lists/workflows";
import type { PipelineBoard, PipelineFilters, PipelineTable } from "@/lib/core-data/lists/types";
import { getLeadProperty } from "@/lib/core-data/dealflow-sync/property-lookup";
import { applySync } from "@/lib/core-data/dealflow-sync/write";
import type { DerivedSignalUpsert } from "@/lib/core-data/dealflow-sync/sync";

// Brief 45 PR G — "our value and range" (Brief 44's estimate, stored by the
// 7:00 sync on each seller's signal as dealflowRawJson.property) on list pages
// and the Pipeline, plus the Pipeline's value-range filter. Against a real
// Postgres (CI's db-suite). Made-up leads and made-up values only.
//
// Rules under test:
//   - the value is the lead page's (getLeadProperty): the best-ranked signal
//     that names the lead, or carries its Mojo ID while naming no other lead
//     of the org; another org's signal never shows;
//   - only a value toPropertyFacts would keep counts (JSON numbers, low ≤ value
//     ≤ high, low ≥ half, high ≤ twice, ≤ $1,000,000,000, a real as-of day);
//   - values stay out of every CSV export [Ryan, 2026-10-17: our estimates never
//     reach anything a buyer or homeowner sees; engineering precaution: exports
//     can be forwarded];
//   - the value filter keeps everyone's global rank, includes both ends, and
//     leaves out people without a value; no extra round trip.
const TAG = `b45v_${Date.now()}`;
let db: PrismaClient;
const orgs: string[] = [];

async function org(suffix: string): Promise<string> {
  const id = await makeOrg(db, `${TAG}_${suffix}`);
  orgs.push(id);
  return id;
}

beforeAll(async () => {
  db = prismaPerf(3);
  await db.$connect();
});

afterAll(async () => {
  for (const o of orgs) await dropOrg(db, o);
  await db?.$disconnect();
});

/** A made-up estimate in the shape Brief 44's sync stores (toPropertyFacts' output). */
function property(value: number | null, low: number | null, high: number | null, extra: Record<string, unknown> = {}) {
  return {
    asOf: "2026-10-01", dataThrough: "2026-09-30", publishedAt: "2026-10-18T09:00:00.000Z",
    value, low, high, reason: value === null ? "not_found" : null,
    facts: { units: 2, buildingSqft: 2400, lotSqft: 2000, yearBuilt: 1901, floors: 3, zoning: "R6B", buildingClass: "B1", historicDistrict: true,
      lastSale: { date: "2015-06-01", price: 990000 }, dofMarketValue: { value: 1400000, fiscalYear: 2027 }, permits7y: { count: 1, major: false },
      openViolations: { dob: 0, ecb: 0, hpd: 0 }, subwayMiles: 0.3, leadVsCity: null },
    comps: value === null ? [] : [{ address: "120 Example St", date: "2026-08-01", price: 1750000, pricePerSqft: 712, distanceMiles: 0.1 }],
    sources: { downloadedOn: "2026-10-18", salesThrough: "2026-09-30", plutoVersion: "26v2", rollFiscalYear: 2027, datasets: {} },
    ...extra,
  };
}

const est = (value: number, low: number, high: number) => ({ value, low, high });

/** A signal as the morning sync writes it (UPSERT by Mojo ID, with dealflowRawJson). */
function sig(mojoId: string, crmLeadId: string | null, queueRank: number | null, prop: unknown): DerivedSignalUpsert {
  return {
    mojoId, crmLeadId, queueRank, priorityScore: 50, queueReason: null, primaryMatchId: null, primaryMatchFit: 70,
    primaryCaptureStatus: null, primaryMatchConfidence: null, matchReason: null, dealflowDeepLink: null,
    dealflowRawJson: { crmLeadId, queueRank, buyers: [], property: prop as never },
  };
}

/** A signal whose JSON is written as text, so numbers JSON.stringify can't make (1e-400, 1e400) survive. */
async function rawSignal(organizationId: string, mojoId: string, json: string): Promise<void> {
  await db.$executeRaw`INSERT INTO "DealFlowDerivedSignal" (id, "organizationId", "mojoId", "syncedAt", "dealflowRawJson")
    VALUES (${`${mojoId}_id`}, ${organizationId}, ${mojoId}, now(), ${json}::jsonb)`;
}

const valueOf = (p: { value: number | null; low: number | null; high: number | null } | null) =>
  p && p.value !== null ? { value: p.value, low: p.low, high: p.high } : null;

describe("which signal's value a lead shows: the lead page's (getLeadProperty)", () => {
  let o: string;
  let other: string;
  const L: Record<string, string> = {};
  let listId: string;
  const M = (k: string) => `${TAG}_m${k}`;

  beforeAll(async () => {
    o = await org("which");
    other = await org("which_other");
    for (const k of ["A", "B", "C", "E", "F", "G", "H", "I", "J"]) {
      L[k] = await makeLead(db, o, { id: `${TAG}_w${k}`, displayName: `Value owner ${k}`, mojoId: M(k) });
    }
    L.D = await makeLead(db, o, { id: `${TAG}_wD`, displayName: "Value owner D", mojoId: null });
    L.Y = await makeLead(db, other, { id: `${TAG}_wY`, displayName: "Other org owner Y", mojoId: `${TAG}_mY` });
    await applySync(o, [
      sig(`${TAG}_xA1`, L.A, 2, property(1_000_000, 900_000, 1_200_000)), // A: two signals name A; the best-ranked wins
      sig(`${TAG}_xA2`, L.A, 7, property(2_000_000, 1_800_000, 2_400_000)),
      sig(M("B"), L.Y, 3, property(1_100_000, 1_000_000, 1_300_000)), // names another org's lead: B keeps it by Mojo ID
      sig(M("C"), L.D, 4, property(1_200_000, 1_100_000, 1_400_000)), // C's Mojo ID, but DealFlow gave it to lead D
      sig(M("F"), null, 6, property(1_300_000, 1_200_000, 1_500_000)), // F: by Mojo ID only
      sig(`${TAG}_xG1`, L.G, null, property(1_400_000, 1_300_000, 1_600_000)), // G: an unranked signal loses to a ranked one
      sig(`${TAG}_xG2`, L.G, 3, property(1_500_000, 1_400_000, 1_700_000)),
      sig(`${TAG}_xH`, L.H, 5, property(1_600_000, 1_500_000, 1_800_000)), // H: names H, but ranks below H's own Mojo-ID signal
      sig(M("H"), null, 2, property(1_700_000, 1_600_000, 1_900_000)),
      sig(`${TAG}_xI`, L.I, null, property(1_800_000, 1_700_000, 2_000_000)), // I: a tie (both unranked): the one naming I
      sig(M("I"), null, null, property(1_900_000, 1_800_000, 2_100_000)),
      sig(`${TAG}_xJ1`, L.J, 1, property(null, null, null)), // J: its best signal has no value: no value (no fallback)
      sig(`${TAG}_xJ2`, L.J, 8, property(2_100_000, 2_000_000, 2_300_000)),
    ], db);
    // E: another organization's signal names lead E (and carries E's Mojo ID's neighbor). It never shows here.
    await db.dealFlowDerivedSignal.create({
      data: { organizationId: other, mojoId: `${TAG}_xP`, queueRank: 1, dealflowRawJson: { crmLeadId: L.E, property: property(9_900_000, 9_000_000, 9_990_000) } },
    });
    listId = (await createList(o, { name: "Values", leadIds: Object.entries(L).filter(([k]) => k !== "Y").map(([, id]) => id) }, db)).list.id;
    const g = await createGroup(o, { name: "Everyone" }, db);
    await addGroupMembers(o, g.group.id, Object.entries(L).filter(([k]) => k !== "Y").map(([, id]) => id), db);
  });

  const expected: Record<string, { value: number; low: number; high: number } | null> = {
    A: est(1_000_000, 900_000, 1_200_000),
    B: est(1_100_000, 1_000_000, 1_300_000),
    C: null,
    D: est(1_200_000, 1_100_000, 1_400_000),
    E: null,
    F: est(1_300_000, 1_200_000, 1_500_000),
    G: est(1_500_000, 1_400_000, 1_700_000),
    H: est(1_700_000, 1_600_000, 1_900_000),
    I: est(1_800_000, 1_700_000, 2_000_000),
    J: null,
  };

  it("list page, All leads, Pipeline table and board show the same value for each person", async () => {
    const page = await getRankedPage(o, listId, {}, db);
    const all = await getRankedPage(o, null, {}, db);
    const table = (await getPipeline(o, { view: "table", filters: {} }, {}, db)) as PipelineTable;
    const board = (await getPipeline(o, { view: "board", filters: {} }, {}, db)) as PipelineBoard;
    for (const [k, want] of Object.entries(expected)) {
      const id = L[k];
      expect([k, page.rows.find((r) => r.leadId === id)?.value]).toEqual([k, want]);
      expect([k, all.rows.find((r) => r.leadId === id)?.value]).toEqual([k, want]);
      expect([k, table.rows.find((r) => r.leadId === id)?.value]).toEqual([k, want]);
      expect([k, board.columns[0].cards.find((c) => c.leadId === id)?.value]).toEqual([k, want]);
    }
  });

  it("matches what the lead page's value card shows (getLeadProperty), wherever the lead page has an order", async () => {
    const page = await getRankedPage(o, listId, {}, db);
    // I is a tie between two unranked signals: the lead page doesn't order ties, the list takes the one naming I.
    for (const k of Object.keys(expected).filter((x) => x !== "I")) {
      const lead = await db.lead.findUniqueOrThrow({ where: { id: L[k] } });
      const card = valueOf(await getLeadProperty(o, { id: lead.id, mojoId: lead.mojoId }, db));
      expect([k, page.rows.find((r) => r.leadId === lead.id)?.value ?? null]).toEqual([k, card]);
    }
  });

  it("only this page's leads are looked up, and the page says the org has values", async () => {
    expect((await getRankedPage(o, listId, {}, db)).hasValues).toBe(true);
    const t = (await getPipeline(o, { view: "table", filters: {} }, {}, db)) as PipelineTable;
    expect(t.filterOptions.hasValues).toBe(true);
  });
});

describe("only an estimate toPropertyFacts would keep counts", () => {
  let o: string;
  let listId: string;
  // key → the signal's JSON text (written as text so 1e-400 and 1e400 stay numbers)
  const cases: [string, string, boolean][] = [
    ["ok", JSON.stringify({ property: property(1_830_000, 1_540_000, 2_120_000) }), true],
    ["cents", JSON.stringify({ property: property(1_830_000.5, 1_540_000.25, 2_120_000.75) }), true],
    ["edges", JSON.stringify({ property: property(1_000_000, 500_000, 2_000_000) }), true], // low = half, high = twice
    ["billion", JSON.stringify({ property: property(1_000_000_000, 500_000_000, 1_000_000_000) }), true],
    ["text", JSON.stringify({ property: { ...property(null, null, null), value: "1830000", low: "1540000", high: "2120000" } }), false],
    ["negative", JSON.stringify({ property: property(-1_830_000, -2_000_000, -1_540_000) }), false],
    ["zero", JSON.stringify({ property: property(0, 0, 0) }), false],
    ["nan", JSON.stringify({ property: { ...property(null, null, null), value: "NaN", low: "NaN", high: "NaN" } }), false],
    ["missing_low", JSON.stringify({ property: { ...property(1_830_000, 1_540_000, 2_120_000), low: undefined } }), false],
    ["low_above", JSON.stringify({ property: property(1_830_000, 1_900_000, 2_120_000) }), false],
    ["too_wide_high", JSON.stringify({ property: property(1_000_000, 900_000, 2_000_001) }), false],
    ["too_wide_low", JSON.stringify({ property: property(1_000_000, 499_999, 1_100_000) }), false],
    ["over_cap", JSON.stringify({ property: property(1_200_000_000, 1_100_000_000, 1_300_000_000) }), false],
    ["huge", `{"property": {"asOf": "2026-10-01", "value": 1e400, "low": 1e400, "high": 1e400}}`, false],
    ["tiny", `{"property": {"asOf": "2026-10-01", "value": 1e-400, "low": 1e-400, "high": 1e-400}}`, false],
    ["no_as_of", JSON.stringify({ property: { ...property(1_830_000, 1_540_000, 2_120_000), asOf: undefined } }), false],
    ["bad_day", JSON.stringify({ property: property(1_830_000, 1_540_000, 2_120_000, { asOf: "2026-02-30" }) }), false],
    ["time_not_day", JSON.stringify({ property: property(1_830_000, 1_540_000, 2_120_000, { asOf: "2026-10-01T00:00:00Z" }) }), false],
    ["array", JSON.stringify({ property: [1_830_000, 1_540_000, 2_120_000] }), false],
    ["string", JSON.stringify({ property: "1830000" }), false],
    ["null", JSON.stringify({ property: null }), false],
    ["absent", JSON.stringify({ crmLeadId: null }), false],
  ];
  const ids: Record<string, string> = {};

  beforeAll(async () => {
    o = await org("shapes");
    for (const [k, json] of cases) {
      ids[k] = await makeLead(db, o, { id: `${TAG}_s_${k}`, displayName: `Shape owner ${k}`, mojoId: `${TAG}_ms_${k}` });
      await rawSignal(o, `${TAG}_ms_${k}`, json);
    }
    listId = (await createList(o, { name: "Shapes", leadIds: Object.values(ids) }, db)).list.id;
  });

  it("text, negative, zero, NaN-ish, incomplete, out-of-range or undated estimates show no value; the page never errors", async () => {
    const page = await getRankedPage(o, listId, {}, db);
    expect(page.rows).toHaveLength(cases.length);
    for (const [k, , ok] of cases) {
      const v = page.rows.find((r) => r.leadId === ids[k])!.value;
      expect([k, v !== null]).toEqual([k, ok]);
    }
    expect(page.rows.find((r) => r.leadId === ids.ok)!.value).toEqual(est(1_830_000, 1_540_000, 2_120_000));
    expect(page.rows.find((r) => r.leadId === ids.cents)!.value).toEqual(est(1_830_000.5, 1_540_000.25, 2_120_000.75));
  });

  it("agrees with the lead page's card (toPropertyFacts) on every one of them", async () => {
    const page = await getRankedPage(o, listId, {}, db);
    for (const [k] of cases) {
      const card = valueOf(await getLeadProperty(o, { id: ids[k], mojoId: `${TAG}_ms_${k}` }, db));
      expect([k, page.rows.find((r) => r.leadId === ids[k])!.value]).toEqual([k, card]);
    }
  });

  it("an organization whose estimates are all unusable has no values (nothing to filter on yet)", async () => {
    const bad = await org("shapes_bad");
    const id = await makeLead(db, bad, { displayName: "Shape owner bad", mojoId: `${TAG}_ms_bad` });
    await rawSignal(bad, `${TAG}_ms_bad`, cases.find(([k]) => k === "text")![1]);
    const page = await getRankedPage(bad, null, {}, db);
    expect(page.hasValues).toBe(false);
    expect(page.rows.find((r) => r.leadId === id)!.value).toBeNull();
  });
});

describe("before DealFlow's estimates arrive", () => {
  it("no signal at all: no values anywhere, and the page says the org has none yet", async () => {
    const o = await org("none");
    const lead = await makeLead(db, o, { displayName: "No value owner", mojoId: `${TAG}_m_none`, priorityScore: 40 });
    const g = await createGroup(o, { name: "Hot" }, db);
    await addGroupMembers(o, g.group.id, [lead], db);
    const page = await getRankedPage(o, null, {}, db);
    expect(page.hasValues).toBe(false);
    expect(page.rows.map((r) => r.value)).toEqual([null]);
    const t = (await getPipeline(o, { view: "table", filters: {} }, {}, db)) as PipelineTable;
    expect(t.filterOptions.hasValues).toBe(false);
    expect(t.rows.map((r) => r.value)).toEqual([null]);
    const b = (await getPipeline(o, { view: "board", filters: {} }, {}, db)) as PipelineBoard;
    expect(b.filterOptions.hasValues).toBe(false);
    expect(b.columns[0].cards.map((c) => c.value)).toEqual([null]);
  });
});

describe("the Pipeline's value-range filter [brief §5.6]", () => {
  let o: string;
  let hot: string;
  let nurture: string;
  const L: Record<string, string> = {};
  // key, priority (rank order), value (null = no estimate)
  const specs: [string, number, number | null][] = [
    ["v1", 99, 900_000],
    ["v2", 95, 1_000_000],
    ["v3", 90, null],
    ["v4", 85, 1_500_000],
    ["v5", 80, 2_000_000],
    ["v6", 75, null],
    ["v7", 70, 2_000_001],
  ];
  const table = async (filters: PipelineFilters) => (await getPipeline(o, { view: "table", filters }, {}, db)) as PipelineTable;
  const keysOf = (rows: { leadId: string }[]) => rows.map((r) => Object.entries(L).find(([, id]) => id === r.leadId)![0]);

  beforeAll(async () => {
    o = await org("filter");
    // Someone outside every group ranks first in All leads, so Pipeline ranks start at 2.
    await makeLead(db, o, { displayName: "Filter owner top", priorityScore: 100 });
    for (const [k, priorityScore, value] of specs) {
      L[k] = await makeLead(db, o, { id: `${TAG}_f_${k}`, displayName: `Filter owner ${k}`, priorityScore, mojoId: `${TAG}_mf_${k}` });
      if (value !== null) {
        await db.dealFlowDerivedSignal.create({
          data: { organizationId: o, mojoId: `${TAG}_mf_${k}`, queueRank: 100 - priorityScore, dealflowRawJson: { crmLeadId: L[k], property: property(value, value - 100_000, value + 100_000) } },
        });
      }
    }
    hot = (await createGroup(o, { name: "Hot" }, db)).group.id;
    nurture = (await createGroup(o, { name: "Nurture" }, db)).group.id;
    await addGroupMembers(o, hot, [L.v1, L.v2, L.v3, L.v4], db);
    await addGroupMembers(o, nurture, [L.v4, L.v5, L.v6, L.v7], db);
  });

  it("both ends are included; people without an estimate are left out; ranks stay their place in All leads", async () => {
    const before = await table({});
    expect(keysOf(before.rows)).toEqual(["v1", "v2", "v3", "v4", "v5", "v6", "v7"]);
    const rankOf = new Map(before.rows.map((r) => [r.leadId, r.rank]));
    expect(before.rows.map((r) => r.rank)).toEqual([2, 3, 4, 5, 6, 7, 8]);

    const range = await table({ valueMin: "1000000", valueMax: "2000000" });
    expect(keysOf(range.rows)).toEqual(["v2", "v4", "v5"]);
    expect(range.total).toBe(3);
    for (const r of range.rows) expect(r.rank).toBe(rankOf.get(r.leadId)); // global rank numbers, unchanged
    expect(range.rows.map((r) => r.value?.value)).toEqual([1_000_000, 1_500_000, 2_000_000]);

    expect(keysOf((await table({ valueMin: "1500000" })).rows)).toEqual(["v4", "v5", "v7"]);
    expect(keysOf((await table({ valueMax: "999999" })).rows)).toEqual(["v1"]);
    expect(keysOf((await table({ valueMin: "0" })).rows)).toEqual(["v1", "v2", "v4", "v5", "v7"]); // no estimate = left out
    expect(keysOf((await table({ valueMin: "2000002" })).rows)).toEqual([]);
  });

  it("works with the other filters and the board: per-column counts, global ranks", async () => {
    const b = (await getPipeline(o, { view: "board", filters: { valueMin: "1000000", valueMax: "2000000" } }, {}, db)) as PipelineBoard;
    expect(b.columns.map((c) => [c.group.name, c.count, c.cards.map((x) => keysOf([x])[0])])).toEqual([
      ["Hot", 2, ["v2", "v4"]],
      ["Nurture", 2, ["v4", "v5"]],
    ]);
    expect(b.columns[1].cards.map((c) => c.rank)).toEqual([5, 6]);
    expect(b.columns[0].cards[1].value).toEqual(est(1_500_000, 1_400_000, 1_600_000));
    const both = await table({ valueMin: "1000000", q: "owner v4" });
    expect(keysOf(both.rows)).toEqual(["v4"]);
    // One column's "load more" keeps the filter.
    const more = (await getPipeline(o, { view: "board", filters: { valueMax: "1000000" }, column: hot, page: 1 }, {}, db)) as PipelineBoard;
    expect(more.columns.map((c) => [c.count, c.cards.map((x) => keysOf([x])[0])])).toEqual([[2, ["v1", "v2"]]]);
  });

  it("saved workflows keep the value range; a backwards or bad range is refused in plain English", async () => {
    const wf = await createWorkflow(o, { name: "Two to three million", view: "table", filters: { valueMin: "2000000", valueMax: "3000000" }, groupIds: [] }, db);
    expect(wf.filters).toEqual({ valueMin: "2000000", valueMax: "3000000" });
    await expect(createWorkflow(o, { name: "Backwards", view: "board", filters: { valueMin: "3000000", valueMax: "2000000" }, groupIds: [] }, db))
      .rejects.toEqual(expect.objectContaining({ status: 400 }));
    await expect(createWorkflow(o, { name: "Words", view: "board", filters: { valueMin: "a lot" } as never, groupIds: [] }, db))
      .rejects.toEqual(expect.objectContaining({ status: 400 }));
    await expect(createWorkflow(o, { name: "Too big", view: "board", filters: { valueMax: "1000000001" }, groupIds: [] }, db))
      .rejects.toEqual(expect.objectContaining({ status: 400 }));
    expect((await updateWorkflow(o, wf.id, { filters: { valueMax: "1500000" } }, db)).filters).toEqual({ valueMax: "1500000" });
  });
});

describe("no extra round trips [brief §7]", () => {
  it("a list page is still 2 queries and the Pipeline 3 (value filter on or off)", async () => {
    const o = await org("queries");
    const ids: string[] = [];
    for (let i = 0; i < 5; i++) {
      const id = await makeLead(db, o, { displayName: `Query owner ${i}`, priorityScore: 50 - i, mojoId: `${TAG}_mq_${i}` });
      ids.push(id);
      await db.dealFlowDerivedSignal.create({ data: { organizationId: o, mojoId: `${TAG}_mq_${i}`, dealflowRawJson: { crmLeadId: id, property: property(1_000_000 + i, 900_000, 1_100_000) } } });
    }
    const listId = (await createList(o, { name: "Queries", leadIds: ids }, db)).list.id;
    const g = await createGroup(o, { name: "Hot" }, db);
    await addGroupMembers(o, g.group.id, ids, db);

    const u = new URL(perfConnectionString());
    u.searchParams.set("connection_limit", "3");
    const client = new PrismaClient({ datasourceUrl: u.toString(), log: [{ emit: "event", level: "query" }] });
    let queries = 0;
    client.$on("query", () => { queries += 1; });
    const counted = client as unknown as PrismaClient;
    try {
      await counted.$connect();
      const page = await getRankedPage(o, listId, {}, counted);
      expect(page.rows.map((r) => r.value?.value)).toEqual([1_000_000, 1_000_001, 1_000_002, 1_000_003, 1_000_004]);
      expect(queries).toBeLessThanOrEqual(2);
      for (const filters of [{}, { valueMin: "1000002" }] as PipelineFilters[]) {
        for (const view of ["table", "board"] as const) {
          queries = 0;
          await getPipeline(o, { view, filters }, {}, counted);
          expect([view, JSON.stringify(filters), queries <= 3]).toEqual([view, JSON.stringify(filters), true]);
        }
      }
    } finally {
      await counted.$disconnect();
    }
  });
});

describe("values never leave in a CSV export [Ryan, 2026-10-17; engineering precaution]", () => {
  it("the list and All leads exports have the same columns as before and no estimate anywhere", async () => {
    const o = await org("export");
    const ids: string[] = [];
    for (let i = 0; i < 3; i++) {
      const id = await makeLead(db, o, { displayName: `Export owner ${i}`, address: `${200 + i} Example St`, priorityScore: 60 - i, mojoId: `${TAG}_me_${i}` });
      ids.push(id);
      await db.dealFlowDerivedSignal.create({ data: { organizationId: o, mojoId: `${TAG}_me_${i}`, dealflowRawJson: { crmLeadId: id, property: property(1_837_000 + i, 1_541_000, 2_123_000) } } });
    }
    const listId = (await createList(o, { name: "Export", leadIds: ids }, db)).list.id;
    expect((await getRankedPage(o, listId, {}, db)).rows.map((r) => r.value?.value)).toEqual([1_837_000, 1_837_001, 1_837_002]); // the page has them…
    for (const out of [await exportRankedCsv(o, listId, {}, db), await exportRankedCsv(o, null, {}, db)]) {
      const lines = out.csv.split("\n");
      expect(lines[0]).toBe(EXPORT_COLUMNS.join(","));
      expect(lines[0]).not.toMatch(/value|estimate|range/i);
      expect(lines).toHaveLength(4);
      // …the exports don't: no amount, compact or not, and no "likely" range.
      expect(out.csv).not.toMatch(/183700|154100|212300|1\.8[0-9]M|\$|likely/);
    }
  });
});
