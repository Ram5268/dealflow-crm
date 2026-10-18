import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { PrismaClient, type Prisma } from "@prisma/client";
import { prismaPerf, perfConnectionString } from "./setup/pg";
import { makeOrg, dropOrg, makeLead, setField, daysBefore } from "./setup/b45";
import { createList } from "@/lib/core-data/lists/lists";
import { addListMembers } from "@/lib/core-data/lists/memberships";
import { createGroup, addGroupMembers } from "@/lib/core-data/lists/groups";
import { getRankedPage, getRankedIds, exportRankedCsv } from "@/lib/core-data/lists/ranked";
import { compareRank, attemptsFrom, type RankKey } from "@/lib/core-data/lists/rules";
import { boroughOf } from "@/lib/core-data/lists/geo";
import { bestBuyerLookup } from "@/lib/core-data/dealflow-sync/buyer-lookup";
import { buyerName } from "@/lib/core-data/dealflow-sync/buyers";

// Brief 45 PR A — every list is always ranked, computed on read (brief §5.5,
// CONTRACT §3), against a real Postgres (CI's db-suite). Made-up leads only.
const TAG = `b45r_${Date.now()}`;
const T = new Date("2026-10-01T12:00:00Z");
const hours = (h: number) => new Date(T.getTime() + h * 3_600_000);
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

describe("ranking order and every tie-break [brief §5.5; CONTRACT §3]", () => {
  let o: string;
  let listId: string;
  const fixture: (RankKey & { key: string })[] = [];

  beforeAll(async () => {
    o = await org("order");
    // key, priority, fit, attempts source, createdAt
    const specs: [string, number | null, number | null, { valueNumber?: number; valueText?: string } | null, Date][] = [
      ["A", 90, null, { valueNumber: 5 }, T],
      ["B", 80, 90, { valueNumber: 9 }, T],
      ["C", 80, 70, { valueNumber: 1 }, T],
      ["D", 80, 70, { valueText: " 2 " }, T],
      ["E", 80, 70, { valueText: "2.5" }, T],
      ["F", 80, 70, null, hours(2)], // missing → 0
      ["G", 80, 70, { valueText: "three" }, hours(1)], // not a number → 0
      ["H", 80, 70, { valueText: "-1" }, hours(1)], // not "strictly numeric" → 0; ties G on everything but id
      ["N", 80, 70, { valueNumber: 3, valueText: "0" }, T], // valueNumber wins
      ["I", 80, null, null, T],
      ["M", 0, 10, null, T], // zero is a score, not "no score"
      ["J", null, 99, null, T],
      ["K", null, null, null, daysBefore(T, 1)],
      ["L", null, null, null, T],
    ];
    for (const [key, priorityScore, topMatchFit, attempts, createdAt] of specs) {
      const id = `${TAG}_${key.toLowerCase()}`;
      await makeLead(db, o, { id, displayName: `Ranked owner ${key}`, priorityScore, topMatchFit, createdAt });
      if (attempts) await setField(db, o, id, "Call Attempts", attempts, "number");
      fixture.push({ key, id, priorityScore, topMatchFit, createdAt, attempts: attemptsFrom(attempts?.valueNumber ?? null, attempts?.valueText ?? null) });
    }
    listId = (await createList(o, { name: "Ranked", leadIds: fixture.map((f) => f.id) }, db)).list.id;
  });

  it("orders by priority, then match fit, then fewer attempts, then who was added first, then id", async () => {
    const expected = ["A", "B", "G", "H", "F", "C", "D", "E", "N", "I", "M", "J", "K", "L"];
    const byId = new Map(fixture.map((f) => [f.id, f.key]));
    expect((await getRankedIds(o, listId, {}, db)).map((id) => byId.get(id))).toEqual(expected);
    // All leads uses the same order.
    expect((await getRankedIds(o, null, {}, db)).map((id) => byId.get(id))).toEqual(expected);
  });

  it("the SQL ranking and compareRank agree on the same rows", async () => {
    const sorted = [...fixture].sort(compareRank).map((f) => f.id);
    expect(await getRankedIds(o, listId, {}, db)).toEqual(sorted);
    const page = await getRankedPage(o, listId, {}, db);
    expect(page.rows.map((r) => r.leadId)).toEqual(sorted);
    expect(page.rows.map((r) => r.rank)).toEqual(sorted.map((_, i) => i + 1));
    expect(page.rows.find((r) => r.leadId === `${TAG}_n`)?.attempts).toBe(3);
    expect(page.rows.find((r) => r.leadId === `${TAG}_e`)?.attempts).toBe(2.5);
    expect(page.rows.find((r) => r.leadId === `${TAG}_g`)?.attempts).toBe(0);
  });
});

describe("paging and filters keep global rank numbers [brief §5.4]", () => {
  let o: string;
  let listId: string;
  let ids: string[];

  beforeAll(async () => {
    o = await org("paging");
    await db.lead.createMany({
      data: Array.from({ length: 250 }, (_, i) => ({
        id: `${TAG}_p${String(i).padStart(3, "0")}`,
        organizationId: o,
        displayName: `Paged owner ${String(i).padStart(3, "0")}`,
        primaryAddressSummary: `${100 + i} Example St`,
        priorityScore: 1000 - i,
        topMatchFit: i % 2 === 0 ? 85 : 60,
      })),
    });
    ids = Array.from({ length: 250 }, (_, i) => `${TAG}_p${String(i).padStart(3, "0")}`);
    listId = (await createList(o, { name: "Paged" }, db)).list.id;
    expect(await addListMembers(o, listId, ids, {}, db)).toEqual({ added: 250, alreadyIn: 0, notFound: 0 });
  });

  it("pages are 100 rows with global rank numbers; a page past the end is empty but keeps the total", async () => {
    const p1 = await getRankedPage(o, listId, { page: 1 }, db);
    expect(p1).toMatchObject({ total: 250, memberCount: 250, page: 1, pageSize: 100 });
    expect(p1.rows.map((r) => r.rank)).toEqual(Array.from({ length: 100 }, (_, i) => i + 1));
    const p3 = await getRankedPage(o, listId, { page: 3 }, db);
    expect(p3.rows.map((r) => r.rank)).toEqual(Array.from({ length: 50 }, (_, i) => 201 + i));
    expect(p3.rows.map((r) => r.leadId)).toEqual(ids.slice(200));
    const p4 = await getRankedPage(o, listId, { page: 4 }, db);
    expect(p4.rows).toEqual([]);
    expect(p4.total).toBe(250);
    expect(p1.list).toMatchObject({ id: listId, name: "Paged", folderName: null, memberCount: 250 });
  });

  it("search and filters narrow the list but each row keeps its rank in the full list", async () => {
    const searched = await getRankedPage(o, listId, { filters: { q: "owner 1" } }, db);
    expect(searched.total).toBe(100); // 100..199
    expect(searched.memberCount).toBe(250);
    expect(searched.rows.map((r) => r.rank)).toEqual(Array.from({ length: 100 }, (_, i) => 101 + i));
    const strong = await getRankedPage(o, listId, { filters: { strongBuyer: true }, page: 2 }, db);
    expect(strong.total).toBe(125);
    expect(strong.rows[0]).toMatchObject({ rank: 201, leadId: ids[200] }); // the 101st strong one sits at 201
    expect(strong.rows.every((r) => (r.topMatchFit ?? 0) >= 80)).toBe(true);
    // Address search, case-insensitive; LIKE wildcards in the search box are literal.
    expect((await getRankedIds(o, listId, { filters: { q: "123 EXAMPLE" } }, db))).toEqual([ids[23]]);
    expect(await getRankedIds(o, listId, { filters: { q: "%" } }, db)).toEqual([]);
    expect(await getRankedIds(o, listId, { filters: { q: "_" } }, db)).toEqual([]);
  });

  it("ids=1 returns every matching id in rank order", async () => {
    expect(await getRankedIds(o, listId, {}, db)).toEqual(ids);
    expect(await getRankedIds(o, null, { filters: { q: "owner 24" } }, db)).toEqual(ids.slice(240));
  });

  it("a page costs 2 queries (CONTRACT §6a allows 3)", async () => {
    const u = new URL(perfConnectionString());
    u.searchParams.set("connection_limit", "3");
    const client = new PrismaClient({ datasourceUrl: u.toString(), log: [{ emit: "event", level: "query" }] });
    let queries = 0;
    client.$on("query", () => { queries += 1; });
    const counted = client as unknown as PrismaClient;
    try {
      await counted.$connect();
      await getRankedPage(o, listId, { page: 2, filters: { q: "owner" } }, counted);
      expect(queries).toBeLessThanOrEqual(2);
      queries = 0;
      await getRankedPage(o, null, {}, counted);
      expect(queries).toBeLessThanOrEqual(2);
    } finally {
      await counted.$disconnect();
    }
  });

  it("a 5,000-member list: first page timing is logged, not gated (docs/known-drift.md)", async () => {
    const big = await org("big");
    await db.lead.createMany({
      data: Array.from({ length: 5_000 }, (_, i) => ({
        organizationId: big,
        displayName: `Big list owner ${i}`,
        priorityScore: i % 7 === 0 ? null : (i * 37) % 101,
        topMatchFit: (i * 13) % 100,
      })),
    });
    const all = (await db.lead.findMany({ where: { organizationId: big }, select: { id: true } })).map((l) => l.id);
    const list = (await createList(big, { name: "Five thousand" }, db)).list.id;
    expect(await addListMembers(big, list, all, {}, db)).toMatchObject({ added: 5_000 });
    await getRankedPage(big, list, {}, db); // warm-up
    const t0 = performance.now();
    const page = await getRankedPage(big, list, {}, db);
    const ms = performance.now() - t0;
    console.log(`[brief45] 5,000-member list, first page: ${ms.toFixed(0)} ms (${page.rows.length} rows)`);
    expect(page.rows).toHaveLength(100);
    expect(page.total).toBe(5_000);
  });
});

describe("row details, rank state and the calling-off rule", () => {
  let o: string;
  let listId: string;
  const NOW = new Date("2026-10-18T16:00:00Z"); // noon in New York
  const L: Record<string, string> = {};

  beforeAll(async () => {
    o = await org("rows");
    const generatedAt = new Date("2026-10-18T09:00:00Z");
    await db.dealFlowDerivedSignal.create({
      data: {
        organizationId: o, mojoId: `${TAG}_mojo_ranked`, priorityScore: 88,
        syncedAt: new Date("2026-10-18T11:02:00Z"),
        dealflowRawJson: {
          crmLeadId: `${TAG}_ranked`, generatedAt: generatedAt.toISOString(),
          buyers: [{ matchId: "m1", score: 91, tier: "HOT", type: "opportunity", name: "Agent One", brokerage: "Example Realty", isTestData: true, phone: "+12125550199" }],
        },
      },
    });
    const before = daysBefore(generatedAt, 2);
    const after = new Date("2026-10-18T13:00:00Z");
    L.ranked = await makeLead(db, o, { id: `${TAG}_ranked`, displayName: "Row owner ranked", address: "100 Example St", priorityScore: 88, topMatchFit: 91, mojoId: `${TAG}_mojo_ranked`, matchReason: "neighborhood + beds", createdAt: before, timezone: "America/New_York" });
    L.looked = await makeLead(db, o, { displayName: "Row owner looked", mojoId: `${TAG}_m2`, dealflowSignalSyncedAt: new Date("2026-10-18T11:02:00Z"), createdAt: after });
    L.old = await makeLead(db, o, { displayName: "Row owner old", mojoId: `${TAG}_m3`, createdAt: before });
    L.noMojoNew = await makeLead(db, o, { displayName: "Row owner no mojo new", createdAt: after });
    L.noMojoOld = await makeLead(db, o, { displayName: "Row owner no mojo old", createdAt: before });
    L.scoring = await makeLead(db, o, { displayName: "Row owner scoring", mojoId: `${TAG}_m4`, createdAt: after });

    await db.contact.create({
      data: {
        organizationId: o, leadId: L.ranked, displayName: "Row owner ranked", timezone: "America/Chicago",
        phones: { create: { phone: "+12125550142", type: "mobile", isPrimary: true } },
        emails: { create: { email: "row.owner@example.com", type: "office" } },
      },
    });
    await db.callingWindowConfig.create({ data: { organizationId: o, timezone: "America/New_York", policyConfirmedBy: "test", policyConfirmedAt: NOW } });
    await setField(db, o, L.ranked, "Call Attempts", { valueNumber: 4 }, "number");
    await setField(db, o, L.ranked, "Last Call Result", { valueText: "Left voicemail" });
    listId = (await createList(o, { name: "Rows", leadIds: Object.values(L) }, db)).list.id;
    const hot = await createGroup(o, { name: "Hot", color: "red" }, db);
    const nurture = await createGroup(o, { name: "Nurture", color: "green" }, db);
    await addGroupMembers(o, nurture.group.id, [L.ranked], db);
    await addGroupMembers(o, hot.group.id, [L.ranked, L.old], db);
  });

  it("each row carries rank, why now, best buyer, group chips in sidebar order, attempts, last result and timezone", async () => {
    const page = await getRankedPage(o, listId, { now: NOW }, db);
    const row = page.rows[0];
    expect(row).toMatchObject({
      rank: 1, leadId: L.ranked, displayName: "Row owner ranked", address: "100 Example St",
      priorityScore: 88, topMatchFit: 91, rankState: "ranked", notRankedReason: null,
      whyNow: "Right neighborhood, bedrooms fit",
      bestBuyer: { name: "Agent One · Example Realty", score: 91, isTestData: true },
      attempts: 4, lastResult: "Left voicemail", timezone: "America/Chicago", calledToday: false,
    });
    expect(row.groups.map((g) => [g.name, g.color])).toEqual([["Hot", "red"], ["Nurture", "green"]]);
    expect(typeof row.addedAt).toBe("string");
    expect(JSON.stringify(page)).not.toMatch(/5550142|5550199|row\.owner@example\.com/); // never a phone or email
    expect(page.rankedAt).toBe("2026-10-18T11:02:00.000Z");
    // Calling windows: the configured zone (confirmed) and the code default for an unconfigured one.
    expect(page.callingWindows["America/New_York"]).toEqual({ earliestHour: 9, latestHour: 20, allowedDaysOfWeek: [1, 2, 3, 4, 5], confirmed: true });
    expect(page.callingWindows["America/Chicago"]).toEqual({ earliestHour: 9, latestHour: 20, allowedDaysOfWeek: [1, 2, 3, 4, 5], confirmed: false });
    // All leads: no list, no addedAt.
    const all = await getRankedPage(o, null, { now: NOW }, db);
    expect(all.list).toBeNull();
    expect(all.memberCount).toBe(6);
    expect(all.rows.every((r) => r.addedAt === null)).toBe(true);
  });

  it("rank state: ranked, not ranked (no match / no Mojo ID), or scoring… (sorts last)", async () => {
    const page = await getRankedPage(o, listId, { now: NOW }, db);
    const state = (id: string) => {
      const r = page.rows.find((x) => x.leadId === id)!;
      return [r.rankState, r.notRankedReason];
    };
    expect(state(L.ranked)).toEqual(["ranked", null]);
    expect(state(L.looked)).toEqual(["not_ranked", "no_match"]); // DealFlow looked and found no match
    expect(state(L.old)).toEqual(["not_ranked", "no_match"]); // was there for the last ranking
    expect(state(L.noMojoNew)).toEqual(["not_ranked", "no_mojo_id"]);
    expect(state(L.noMojoOld)).toEqual(["not_ranked", "no_mojo_id"]); // DealFlow never reads leads without a Mojo ID
    expect(state(L.scoring)).toEqual(["scoring", null]);
    expect(page.rows[0].leadId).toBe(L.ranked); // the only scored one ranks first
  });

  it("filters: group (an id, or none), strong buyer, borough; an unknown group matches nobody", async () => {
    const groups = await db.leadGroup.findMany({ where: { organizationId: o }, orderBy: { sortOrder: "asc" } });
    const hot = groups.find((g) => g.name === "Hot")!.id;
    expect((await getRankedIds(o, listId, { filters: { group: hot } }, db)).sort()).toEqual([L.ranked, L.old].sort());
    expect(await getRankedIds(o, listId, { filters: { group: "none" } }, db)).toHaveLength(4);
    expect(await getRankedIds(o, listId, { filters: { group: "no_such_group" } }, db)).toEqual([]);
    expect(await getRankedIds(o, listId, { filters: { strongBuyer: true } }, db)).toEqual([L.ranked]);
  });

  it("'called today' shows only while calling is on [brief §5.1 rule 3]", async () => {
    const remote = (n: number) => `+1212555${String(100 + n).padStart(4, "0")}`;
    const call = (leadId: string, activityAt: Date, n: number) =>
      db.call.create({ data: { organizationId: o, leadId, direction: "outbound", callMethod: "power", localPhone: remote(0), remotePhone: remote(n), providerCallSid: `${TAG}_call_${n}`, activityAt } });
    await call(L.old, new Date("2026-10-18T14:00:00Z"), 1); // 10am New York today
    await call(L.scoring, new Date("2026-10-18T03:30:00Z"), 2); // 11:30pm New York yesterday
    await setField(db, o, L.looked, "Last Dial Date", { valueDate: new Date("2026-10-18T00:00:00Z") }, "date"); // today (NY wall clock)
    await setField(db, o, L.noMojoNew, "Last Dial Date", { valueDate: new Date("2026-10-17T00:00:00Z") }); // yesterday

    const on = await getRankedPage(o, listId, { now: NOW, callingOn: true }, db);
    expect(on.callingOffReason).toBeNull();
    expect(on.rows.filter((r) => r.calledToday).map((r) => r.leadId).sort()).toEqual([L.old, L.looked].sort());
    expect((await getRankedIds(o, listId, { now: NOW, callingOn: true, filters: { calledToday: true } }, db)).sort()).toEqual([L.old, L.looked].sort());

    const off = await getRankedPage(o, listId, { now: NOW, callingOn: false }, db);
    expect(off.callingOffReason).toBe("Calling is off");
    expect(off.rows.some((r) => r.calledToday)).toBe(false);
    // While calling is off the filter does nothing: it isn't offered.
    expect(await getRankedIds(o, listId, { now: NOW, callingOn: false, filters: { calledToday: true } }, db)).toHaveLength(6);
  });

  it("CSV export: rank order, the agreed columns, no phones or emails, formula-safe cells", async () => {
    const formula = await makeLead(db, o, { displayName: "=HYPERLINK(\"http://example.invalid\")", priorityScore: 1 });
    await addListMembers(o, listId, [formula], {}, db);
    const { csv, filename, truncated } = await exportRankedCsv(o, listId, { now: NOW }, db);
    expect(truncated).toBe(false);
    expect(filename).toMatch(/^Rows-ranked-\d{4}-\d{2}-\d{2}\.csv$/);
    const lines = csv.split("\n");
    expect(lines[0]).toBe("Rank,Name,Address,Priority,Match fit,Why now,Best buyer,Groups,Attempts,Last result,Timezone");
    expect(lines[1]).toBe('1,Row owner ranked,100 Example St,88,91,"Right neighborhood, bedrooms fit",Agent One · Example Realty,Hot; Nurture,4,Left voicemail,Central');
    // The formula gets a leading apostrophe; its quotes then make the cell quoted.
    expect(lines[2].startsWith(`2,"'=HYPERLINK(""http://example.invalid"")"`)).toBe(true);
    expect(lines).toHaveLength(8); // header + 7 people
    expect(csv).not.toMatch(/5550142|row\.owner@example\.com/);
    const all = await exportRankedCsv(o, null, { now: NOW }, db);
    expect(all.filename).toMatch(/^All-leads-ranked-/);
  });
});

describe("borough filter: SQL agrees with boroughOf [CONTRACT §4]", () => {
  it("maps ZIP first, then the city name", async () => {
    const o = await org("borough");
    const cases: [string | null, number | null, string | null][] = [
      ["11215", null, null], ["10013-1234", null, null], ["11004", null, null], ["11001", null, "Floral Park"],
      ["10301", null, null], ["10451", null, null], ["11385", null, "Ridgewood"], [null, null, "Astoria"],
      [null, null, "New York"], [null, null, " brooklyn "], [null, null, "The Bronx"], [null, 11216, null],
      ["07030", null, "Hoboken"], [null, null, null],
    ];
    const ids: string[] = [];
    for (const [i, [zipText, zipNumber, city]] of cases.entries()) {
      const id = await makeLead(db, o, { displayName: `Borough owner ${i}` });
      if (zipText !== null) await setField(db, o, id, "Property Zip Code", { valueText: zipText });
      if (zipNumber !== null) await setField(db, o, id, "Property Zip Code", { valueNumber: zipNumber });
      if (city !== null) await setField(db, o, id, "Property City", { valueText: city });
      ids.push(id);
    }
    const expected = cases.map(([zt, zn, city]) => boroughOf(zt ?? (zn === null ? null : String(zn)), city));
    expect(expected).toEqual([
      "Brooklyn", "Manhattan", "Queens", null, "Staten Island", "Bronx", "Queens", "Queens",
      "Manhattan", "Brooklyn", "Bronx", "Brooklyn", null, null,
    ]);
    for (const borough of ["Manhattan", "Brooklyn", "Queens", "Bronx", "Staten Island"]) {
      const want = ids.filter((_, i) => expected[i] === borough).sort();
      expect((await getRankedIds(o, null, { filters: { borough } }, db)).sort()).toEqual(want);
    }
  });
});

describe("Call Attempts text that is too long counts as 0 [engineering precaution]", () => {
  it("a few hundred digits can't break the ranked page, and SQL still agrees with compareRank", async () => {
    const o = await org("digits");
    const specs: [string, string][] = [["huge", "1".repeat(400)], ["ten", "1234567890"], ["nine", "123456789"], ["small", " 2 "]];
    const fixture: RankKey[] = [];
    for (const [key, text] of specs) {
      const id = `${TAG}_dg_${key}`;
      await makeLead(db, o, { id, displayName: `Digits owner ${key}`, priorityScore: 50, topMatchFit: 50, createdAt: T });
      await setField(db, o, id, "Call Attempts", { valueText: text });
      fixture.push({ id, priorityScore: 50, topMatchFit: 50, createdAt: T, attempts: attemptsFrom(null, text) });
    }
    const page = await getRankedPage(o, null, {}, db);
    expect(page.rows.map((r) => [r.leadId.replace(`${TAG}_dg_`, ""), r.attempts])).toEqual([
      ["huge", 0], ["ten", 0], ["small", 2], ["nine", 123456789],
    ]);
    expect(page.rows.map((r) => r.leadId)).toEqual([...fixture].sort(compareRank).map((f) => f.id));
  });
});

describe("best buyer, read for the page's leads only", () => {
  it("DealFlow's recorded CRM lead id first, else the Mojo ID: the same answer as bestBuyerLookup", async () => {
    const o = await org("buyers");
    const buyer = (matchId: string, name: string) => ({ matchId, score: 80, tier: "HOT", type: "mojo", name, isTestData: true });
    const lead = (key: string, mojoId: string | null) => makeLead(db, o, { id: `${TAG}_bb_${key}`, displayName: `Buyer owner ${key}`, mojoId });
    const signal = (mojoId: string, crmLeadId: string | null, buyers: Prisma.InputJsonObject[]) =>
      db.dealFlowDerivedSignal.create({ data: { organizationId: o, mojoId, dealflowRawJson: { crmLeadId, buyers } } });
    const a = await lead("a", `${TAG}_mA`);
    const b = await lead("b", `${TAG}_mB`);
    const c = await lead("c", `${TAG}_mC`);
    const d = await lead("d", null);
    await signal(`${TAG}_mA_df`, a, [buyer("x", "Buyer X")]); // names lead a directly: wins
    await signal(`${TAG}_mA`, null, [buyer("y", "Buyer Y")]);
    await signal(`${TAG}_mB`, null, [buyer("z", "Buyer Z")]); // by Mojo ID only
    await signal(`${TAG}_mC_df`, c, [{ name: "No match id" }]); // not a usable buyer: skipped
    await signal(`${TAG}_mC`, null, [buyer("w", "Buyer W")]);
    const page = await getRankedPage(o, null, {}, db);
    const got = Object.fromEntries(page.rows.map((r) => [r.leadId, r.bestBuyer?.name ?? null]));
    expect(got).toEqual({ [a]: "Buyer X", [b]: "Buyer Z", [c]: "Buyer W", [d]: null });
    const lookup = await bestBuyerLookup(o, db);
    for (const r of page.rows) {
      const old = lookup({ leadId: r.leadId, mojoId: (await db.lead.findUniqueOrThrow({ where: { id: r.leadId } })).mojoId });
      expect(r.bestBuyer?.name ?? null).toBe(old ? buyerName(old) : null);
    }
  });
});
