import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { PrismaClient } from "@prisma/client";
import { prismaPerf } from "./setup/pg";
import { makeOrg, dropOrg, makeLead, setField, daysBefore } from "./setup/b45";
import { createGroup } from "@/lib/core-data/lists/groups";
import { getPipeline, getPipelineIds } from "@/lib/core-data/lists/pipeline";
import type { PipelineFilters, PipelineQuery, PipelineTable } from "@/lib/core-data/lists/types";

// Brief 50 PR 7 (open item 6.12): "Select all N matching" on the Pipeline
// table. Every id the table shows for these groups, filters and sort, in the
// table's order, across all its pages (at most 25,000 at once, like the list
// pages' and All leads' ids=1), so a bulk action reaches everyone the filters
// show. Organization only. Real Postgres (CI's db-suite), made-up people.
const TAG = `b50p7_ids_${Date.now()}`;
const NOW = new Date("2026-10-14T16:00:00Z");
let db: PrismaClient;
let o: string;
let other: string;
const leads: string[] = [];
let hot: string;
let nurture: string;
let theirs: string;

const table = async (q: Partial<PipelineQuery>) => {
  const rows: string[] = [];
  for (let page = 1; ; page++) {
    const t = (await getPipeline(o, { view: "table", filters: {}, ...q, page }, { now: NOW }, db)) as PipelineTable;
    rows.push(...t.rows.map((r) => r.leadId));
    if (page * t.pageSize >= t.total) return rows;
  }
};
const ids = (q: Partial<PipelineQuery>, opts: { cap?: number } = {}) => getPipelineIds(o, { view: "table", filters: {}, ...q }, { now: NOW, ...opts }, db);

beforeAll(async () => {
  db = prismaPerf(2);
  await db.$connect();
  o = await makeOrg(db, TAG);
  other = await makeOrg(db, `${TAG}_other`);
  hot = (await createGroup(o, { name: "Hot", color: "red" }, db)).group.id;
  nurture = (await createGroup(o, { name: "Nurture", color: "blue" }, db)).group.id;
  // 130 people, so the table has two pages; scores repeat so ties are broken the table's way.
  for (let i = 0; i < 130; i++) {
    const id = await makeLead(db, o, { displayName: `Select owner ${String(i).padStart(3, "0")}`, address: `${100 + i} Example St`, priorityScore: i % 3 === 0 ? null : 40 + (i % 17), topMatchFit: 50 + (i % 5) });
    leads.push(id);
    if (i % 2 === 0) await setField(db, o, id, "Property Zip Code", { valueText: "11215" }); // Brooklyn
  }
  await db.leadGroupMembership.createMany({ data: leads.slice(0, 110).map((leadId, i) => ({ groupId: hot, leadId, addedBy: "manual", addedAt: daysBefore(NOW, i % 40) })) });
  await db.leadGroupMembership.createMany({ data: leads.slice(90).map((leadId) => ({ groupId: nurture, leadId, addedBy: "manual", addedAt: daysBefore(NOW, 3) })) });
  // Another organization's group and person never show.
  theirs = (await createGroup(other, { name: "Hot", color: "red" }, db)).group.id;
  const theirLead = await makeLead(db, other, { displayName: "Select owner theirs", priorityScore: 99 });
  await db.leadGroupMembership.create({ data: { groupId: theirs, leadId: theirLead, addedBy: "manual" } });
});

afterAll(async () => {
  if (o) await dropOrg(db, o);
  if (other) await dropOrg(db, other);
  await db?.$disconnect();
});

describe("Pipeline table: every matching id, for 'Select all N matching'", () => {
  it("everyone in the shown groups, once each, in the table's order across both pages", async () => {
    const all = await ids({});
    expect(all).toHaveLength(130);
    expect(new Set(all).size).toBe(130);
    expect(all).toEqual(await table({}));
  });

  it.each<[string, Partial<PipelineQuery>]>([
    ["one group", { groups: ["nurture"] }],
    ["a filter (borough)", { filters: { borough: "Brooklyn" } }],
    ["a search", { filters: { q: "owner 1" } }],
    ["time in group 30+ days", { filters: { timeInGroup: "30" } as PipelineFilters }],
    ["sorted by name, backwards", { sort: "name", dir: "desc" }],
    ["sorted by time in group", { sort: "inGroupSince", dir: "asc" }],
  ])("with %s: the same people in the same order as the table", async (_label, q) => {
    const query = q.groups ? { ...q, groups: [nurture] } : q;
    const expected = await table(query);
    expect(expected.length).toBeGreaterThan(0);
    expect(await ids(query)).toEqual(expected);
  });

  it("at most the cap, from the top of the table's order", async () => {
    const all = await table({});
    expect(await ids({}, { cap: 7 })).toEqual(all.slice(0, 7));
  });

  it("another organization's groups and people never come back", async () => {
    expect(await ids({ groups: [theirs] })).toEqual([]);
    const theirsOnly = await getPipelineIds(other, { view: "table", filters: {} }, { now: NOW }, db);
    expect(theirsOnly).toHaveLength(1);
    expect(theirsOnly.some((id) => leads.includes(id))).toBe(false);
  });
});
