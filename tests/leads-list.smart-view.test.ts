import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { PrismaClient } from "@prisma/client";
import { prismaPerf } from "./setup/pg";
import { listLeads, type LeadRow, type LeadSortKey, type ListLeadsParams } from "@/lib/leads/list";
import { DEFAULT_VIEW } from "@/lib/core-data/smart-view/defaultView";

// Brief 41 (H1): the Leads page with a Smart View used to fetch the view's first
// 1,000 lead ids and page inside them, so a bigger view silently lost leads and
// reported "of 1000". Against the perf DB, inside a throwaway organization: a
// view of more than 1,000 leads must report its real total and page through
// every lead exactly once, in the same order on every load, even when most rows
// tie on the sort key (DealFlow's ranking is flat).
const TAG = `b41_sv_${Date.now()}`;
const RANKED = 1_050; // more than the old 1,000 cap
const UNRANKED = 40; // NULL priority: outside the "DealFlow priority" filter
const PAGE = 200;
let db: PrismaClient;
let org: string;
let viewId: string;
let brokenViewId: string;
let allViewId: string;

const nameOf = (i: number) => `${TAG} lead ${String(i).padStart(4, "0")}`;

beforeAll(async () => {
  db = prismaPerf(2);
  await db.$connect();
  org = (await db.organization.create({ data: { slug: TAG, name: "Brief 41 smart view test" } })).id;
  await db.lead.createMany({
    data: Array.from({ length: RANKED + UNRANKED }, (_, i) => ({
      organizationId: org,
      displayName: nameOf(i),
      // Three distinct scores, so nearly every row ties with hundreds of others.
      priorityScore: i < RANKED ? [60, 70, 80][i % 3] : null,
      topMatchFit: i < RANKED ? [90, 50, null][Math.floor(i / 3) % 3] : null,
    })),
  });
  viewId = (
    await db.savedView.create({
      data: { organizationId: org, name: "priority", type: "lead", sQuery: DEFAULT_VIEW.sQuery, sort: DEFAULT_VIEW.sort },
    })
  ).id;
  allViewId = (
    await db.savedView.create({ data: { organizationId: org, name: "everyone", type: "lead", sQuery: { type: "match_all" } } })
  ).id;
  brokenViewId = (
    await db.savedView.create({
      data: {
        organizationId: org,
        name: "broken",
        type: "lead",
        sQuery: { type: "field_condition", field: { kind: "regular", table: "lead", column: "nope" }, condition: { type: "text", mode: "exact", value: "x" } },
      },
    })
  ).id;
}, 120_000);

afterAll(async () => {
  if (org) {
    await db.savedView.deleteMany({ where: { organizationId: org } });
    await db.lead.deleteMany({ where: { organizationId: org } });
    await db.organization.delete({ where: { id: org } });
  }
  await db?.$disconnect();
});

async function everyPage(params: Partial<ListLeadsParams>): Promise<{ rows: LeadRow[]; totals: number[] }> {
  const rows: LeadRow[] = [];
  const totals: number[] = [];
  for (let page = 1; page < 50; page++) {
    const r = await listLeads({ organizationId: org, viewId, page, pageSize: PAGE, ...params }, db);
    expect(r.viewError).toBeUndefined();
    totals.push(r.total);
    rows.push(...r.rows);
    if (r.rows.length < PAGE) break;
  }
  return { rows, totals };
}

describe("Leads page with a Smart View (Brief 41, H1)", () => {
  it("reports the view's real total, not 1,000", async () => {
    const r = await listLeads({ organizationId: org, viewId, pageSize: 50 }, db);
    expect(r.viewError).toBeUndefined();
    expect(r.total).toBe(RANKED);
    expect(r.rows).toHaveLength(50);
  });

  it("with no column chosen, pages the whole view in its own saved order (priority, then top match fit)", async () => {
    const first = await listLeads({ organizationId: org, viewId, pageSize: PAGE }, db);
    expect(first.sort).toEqual({ key: "priorityScore", dir: "desc", fromView: true });
    const { rows } = await everyPage({});
    const expected = await db.lead.findMany({
      where: { organizationId: org, priorityScore: { gte: 0 } },
      orderBy: [{ priorityScore: { sort: "desc", nulls: "last" } }, { topMatchFit: { sort: "desc", nulls: "last" } }, { id: "asc" }],
      select: { id: true },
    });
    expect(rows.map((r) => r.id)).toEqual(expected.map((e) => e.id));
  });

  it("a chosen column overrides the view's saved sort", async () => {
    const r = await listLeads({ organizationId: org, viewId, sortKey: "displayName", sortDir: "asc", pageSize: 5 }, db);
    expect(r.sort).toEqual({ key: "displayName", dir: "asc", fromView: false });
    const names = r.rows.map((x) => x.displayName);
    expect(names).toEqual([...names].sort());
    expect(names[0]).toBe(nameOf(0));
  });

  it("clicking the view's own first column keeps the view's tie order", async () => {
    const viewOrder = (await everyPage({})).rows.map((r) => r.id);
    const explicit = (await everyPage({ sortKey: "priorityScore", sortDir: "desc" })).rows.map((r) => r.id);
    expect(explicit).toEqual(viewOrder);
  });

  it("a page past the end is empty but keeps the real total", async () => {
    const r = await listLeads({ organizationId: org, viewId, page: 7, pageSize: PAGE }, db);
    expect(r.rows).toEqual([]);
    expect(r.total).toBe(RANKED);
  });

  it("the same column sort gives the same order with or without a view", async () => {
    for (const [sortKey, sortDir] of [["priorityScore", "desc"], ["displayName", "asc"], ["statusLabel", "asc"]] as const) {
      const withView = await listLeads({ organizationId: org, viewId: allViewId, sortKey, sortDir, pageSize: 500 }, db);
      const without = await listLeads({ organizationId: org, sortKey, sortDir, pageSize: 500 }, db);
      expect(withView.total).toBe(RANKED + UNRANKED);
      expect(withView.rows.map((r) => r.id)).toEqual(without.rows.map((r) => r.id));
    }
  });

  it.each<[LeadSortKey, "asc" | "desc"]>([
    ["priorityScore", "desc"],
    ["updatedAt", "desc"],
    ["displayName", "asc"],
    ["statusLabel", "asc"],
  ])("pages through every lead exactly once, in a stable order (sort %s %s)", async (sortKey, sortDir) => {
    const first = await everyPage({ sortKey, sortDir });
    expect(new Set(first.totals)).toEqual(new Set([RANKED]));
    expect(first.rows).toHaveLength(RANKED);
    expect(new Set(first.rows.map((r) => r.id)).size).toBe(RANKED);
    expect(first.rows.every((r) => r.priorityScore != null)).toBe(true);

    const again = await everyPage({ sortKey, sortDir });
    expect(again.rows.map((r) => r.id)).toEqual(first.rows.map((r) => r.id));
  });

  it("sorts across pages, not just within one page", async () => {
    const { rows } = await everyPage({ sortKey: "priorityScore", sortDir: "desc" });
    const scores = rows.map((r) => r.priorityScore as number);
    expect(scores).toEqual([...scores].sort((a, b) => b - a));
    const names = (await everyPage({ sortKey: "displayName", sortDir: "asc" })).rows.map((r) => r.displayName);
    expect(names).toEqual([...names].sort());
  });

  it("search narrows within the view and the total counts the narrowed set", async () => {
    const term = `${TAG} lead 10`;
    const expected = Array.from({ length: RANKED }, (_, i) => nameOf(i)).filter((n) => n.includes(term)).length;
    expect(expected).toBeGreaterThan(0);
    const r = await listLeads({ organizationId: org, viewId, q: term, pageSize: PAGE }, db);
    expect(r.total).toBe(expected);
    expect(r.rows).toHaveLength(expected);
    expect(r.rows.every((row) => row.displayName.includes(term) && row.priorityScore != null)).toBe(true);
  });

  // Brief 45 PR B: without a view (and without a column) All leads is in the
  // lists' rank order (CONTRACT §3), no longer most recently updated first.
  it("without a view, lists every lead in the organization, in rank order", async () => {
    const r = await listLeads({ organizationId: org, pageSize: 50 }, db);
    expect(r.total).toBe(RANKED + UNRANKED);
    expect(r.sort).toEqual({ key: null, dir: "asc", fromView: false, ranked: true });
    expect(r.rows[0].rank).toBe(1);
  });

  it("a view that cannot be applied falls back to all leads and says why", async () => {
    const broken = await listLeads({ organizationId: org, viewId: brokenViewId, pageSize: 50 }, db);
    expect(broken.viewError).toMatch(/unknown lead column/);
    expect(broken.total).toBe(RANKED + UNRANKED);
    const missing = await listLeads({ organizationId: org, viewId: "save_does_not_exist", pageSize: 50 }, db);
    expect(missing.viewError).toBe("Smart View not found");
    expect(missing.total).toBe(RANKED + UNRANKED);
  });
});
