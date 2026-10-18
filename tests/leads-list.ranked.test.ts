import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { PrismaClient } from "@prisma/client";
import { prismaPerf } from "./setup/pg";
import { makeOrg, dropOrg, setField, daysBefore } from "./setup/b45";
import { listLeads } from "@/lib/leads/list";
import { getRankedIds } from "@/lib/core-data/lists/ranked";
import { createGroup, addGroupMembers } from "@/lib/core-data/lists/groups";
import { DEFAULT_VIEW } from "@/lib/core-data/smart-view/defaultView";

// Brief 45 PR B — All leads (/leads) with no Smart View and no column sort is
// in the same rank order as every list (CONTRACT §3): DealFlow priority, then
// best buyer fit, then fewer call attempts, then who was added first. Rank
// numbers are each person's place in All leads, whatever the search or group
// filter. ?group=<id> narrows to one group; Smart Views and column sorts keep
// working as before. Against a real Postgres (CI's db-suite). Made-up leads.
const TAG = `b45b_${Date.now()}`;
const T = new Date("2026-10-01T12:00:00Z");
const N = 130;
let db: PrismaClient;
let org: string;
let other: string;
let hot: string;
let foreignGroup: string;
let ids: string[];
let viewId: string;

const idOf = (i: number) => `${TAG}_${String(i).padStart(3, "0")}`;

beforeAll(async () => {
  db = prismaPerf(2);
  await db.$connect();
  org = await makeOrg(db, TAG);
  other = await makeOrg(db, `${TAG}_other`);
  // Many ties on priority so fit, attempts, age and id all matter; some unscored.
  await db.lead.createMany({
    data: Array.from({ length: N }, (_, i) => ({
      id: idOf(i),
      organizationId: org,
      displayName: `Ranked owner ${String(i).padStart(3, "0")}`,
      primaryAddressSummary: `${100 + i} Example St`,
      priorityScore: i % 10 === 9 ? null : [70, 80, 90][i % 3],
      topMatchFit: i % 4 === 0 ? null : 50 + (i % 5) * 10,
      createdAt: daysBefore(T, i % 7),
    })),
  });
  for (let i = 0; i < N; i += 6) await setField(db, org, idOf(i), "Call Attempts", { valueNumber: i % 4 }, "number");
  ids = Array.from({ length: N }, (_, i) => idOf(i));
  hot = (await createGroup(org, { name: "Hot", color: "red" }, db)).group.id;
  await addGroupMembers(org, hot, ids.filter((_, i) => i % 3 === 0), db);
  foreignGroup = (await createGroup(other, { name: "Theirs" }, db)).group.id;
  viewId = (
    await db.savedView.create({
      data: { organizationId: org, name: "priority", type: "lead", sQuery: DEFAULT_VIEW.sQuery, sort: DEFAULT_VIEW.sort },
    })
  ).id;
}, 120_000);

afterAll(async () => {
  if (org) await dropOrg(db, org);
  if (other) await dropOrg(db, other);
  await db?.$disconnect();
});

describe("All leads in rank order (no Smart View, no column)", () => {
  it("lists everyone in the lists' rank order, 100 a page, with global rank numbers", async () => {
    const expected = await getRankedIds(org, null, {}, db);
    expect(expected).toHaveLength(N);
    const p1 = await listLeads({ organizationId: org }, db);
    expect(p1.sort).toEqual({ key: null, dir: "asc", fromView: false, ranked: true });
    expect(p1).toMatchObject({ total: N, page: 1, pageSize: 100 });
    expect(p1.rows.map((r) => r.id)).toEqual(expected.slice(0, 100));
    expect(p1.rows.map((r) => r.rank)).toEqual(Array.from({ length: 100 }, (_, i) => i + 1));
    // The usual row fields are still there.
    expect(p1.rows[0]).toMatchObject({ displayName: expect.stringContaining("Ranked owner"), contactCount: 0 });
    expect(p1.rankedAt === null || typeof p1.rankedAt === "string").toBe(true);

    const p2 = await listLeads({ organizationId: org, page: 2 }, db);
    expect(p2.rows.map((r) => r.id)).toEqual(expected.slice(100));
    expect(p2.rows.map((r) => r.rank)).toEqual(Array.from({ length: N - 100 }, (_, i) => 101 + i));
  });

  it("search narrows but keeps each person's place in All leads", async () => {
    const expected = await getRankedIds(org, null, {}, db);
    const r = await listLeads({ organizationId: org, q: "Ranked owner 01" }, db);
    expect(r.total).toBe(10);
    for (const row of r.rows) expect(row.rank).toBe(expected.indexOf(row.id) + 1);
    expect(r.rows.map((x) => x.rank)).toEqual([...r.rows.map((x) => x.rank!)].sort((a, b) => a - b));
  });

  it("?group=<id> shows that group's people, still with their All leads rank", async () => {
    const expected = await getRankedIds(org, null, {}, db);
    const members = new Set(ids.filter((_, i) => i % 3 === 0));
    const r = await listLeads({ organizationId: org, group: hot }, db);
    expect(r.group).toEqual({ id: hot, name: "Hot", color: "red" });
    expect(r.groupError).toBeUndefined();
    expect(r.total).toBe(members.size);
    expect(r.rows.every((row) => members.has(row.id))).toBe(true);
    for (const row of r.rows) expect(row.rank).toBe(expected.indexOf(row.id) + 1);
  });

  it("group=none: the people in no group", async () => {
    const r = await listLeads({ organizationId: org, group: "none" }, db);
    expect(r.group).toEqual({ id: "none", name: "In no group", color: "gray" });
    expect(r.total).toBe(N - Math.ceil(N / 3));
  });

  it("an unknown group, or another organization's, is not applied, and says why", async () => {
    for (const g of ["no_such_group", foreignGroup]) {
      const r = await listLeads({ organizationId: org, group: g }, db);
      expect(r.group).toBeNull();
      expect(r.groupError).toBe("That group no longer exists. Showing all leads.");
      expect(r.total).toBe(N);
    }
  });
});

describe("Smart Views and column sorts keep working as before", () => {
  it("a column sort (no view) orders by that column, filters by the group, and has no rank numbers", async () => {
    const r = await listLeads({ organizationId: org, sortKey: "displayName", sortDir: "asc", group: hot, pageSize: 500 }, db);
    expect(r.sort).toEqual({ key: "displayName", dir: "asc", fromView: false });
    const names = r.rows.map((x) => x.displayName);
    expect(names).toEqual([...names].sort());
    expect(r.total).toBe(Math.ceil(N / 3));
    expect(r.rows.every((x) => x.rank === undefined)).toBe(true);
  });

  it("a Smart View keeps its own order and ignores the group filter", async () => {
    const r = await listLeads({ organizationId: org, viewId, group: hot, pageSize: 500 }, db);
    expect(r.sort).toEqual({ key: "priorityScore", dir: "desc", fromView: true });
    expect(r.total).toBe(ids.filter((_, i) => i % 10 !== 9).length);
    expect(r.group).toBeNull();
    expect(r.rows.every((x) => x.rank === undefined)).toBe(true);
  });

  it("a Smart View that can't be applied falls back to All leads in rank order", async () => {
    const r = await listLeads({ organizationId: org, viewId: "save_does_not_exist" }, db);
    expect(r.viewError).toBe("Smart View not found");
    expect(r.sort.ranked).toBe(true);
    expect(r.rows[0].rank).toBe(1);
    expect(r.total).toBe(N);
  });
});
