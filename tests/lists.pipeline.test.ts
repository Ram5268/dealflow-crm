import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { PrismaClient } from "@prisma/client";
import { prismaPerf } from "./setup/pg";
import { makeOrg, dropOrg, makeLead, setField, daysBefore } from "./setup/b45";
import { createFolder } from "@/lib/core-data/lists/folders";
import { createList, updateList } from "@/lib/core-data/lists/lists";
import { createGroup, addGroupMembers } from "@/lib/core-data/lists/groups";
import { getPipeline, parsePipelineQuery } from "@/lib/core-data/lists/pipeline";
import { listWorkflows, createWorkflow, updateWorkflow, deleteWorkflow } from "@/lib/core-data/lists/workflows";
import { getSidebar } from "@/lib/core-data/lists/sidebar";
import type { PipelineBoard, PipelineFilters, PipelineTable } from "@/lib/core-data/lists/types";
import { listLeads } from "@/lib/leads/list";

// Brief 45 PR A — the Pipeline query (brief §5.6, CONTRACT §6b) and saved
// workflows, against a real Postgres (CI's db-suite). Made-up leads only.
const TAG = `b45p_${Date.now()}`;
const NOW = new Date("2026-10-14T16:00:00Z"); // a Wednesday, noon in New York
let db: PrismaClient;
let o: string;
let other: string;
const L: Record<"l1" | "l2" | "l3" | "l4" | "l5", string> = { l1: "", l2: "", l3: "", l4: "", l5: "" };
const G: Record<"hot" | "nurture" | "appt", string> = { hot: "", nurture: "", appt: "" };
const lists: Record<"x" | "y" | "z", string> = { x: "", y: "", z: "" };
let folder: string;

const table = async (filters: PipelineFilters = {}, extra: Partial<Parameters<typeof getPipeline>[1]> = {}) =>
  (await getPipeline(o, { view: "table", filters, ...extra }, { now: NOW }, db)) as PipelineTable;
const board = async (filters: PipelineFilters = {}, extra: Partial<Parameters<typeof getPipeline>[1]> = {}) =>
  (await getPipeline(o, { view: "board", filters, ...extra }, { now: NOW }, db)) as PipelineBoard;
const names = (t: PipelineTable) => t.rows.map((r) => r.displayName);
const err = (status: number, message?: string) => expect.objectContaining(message ? { status, message } : { status });

beforeAll(async () => {
  db = prismaPerf(2);
  await db.$connect();
  o = await makeOrg(db, TAG);
  other = await makeOrg(db, `${TAG}_other`);

  L.l1 = await makeLead(db, o, { displayName: "Pipeline owner 1", address: "101 Example St", priorityScore: 90, topMatchFit: 85 });
  L.l2 = await makeLead(db, o, { displayName: "Pipeline owner 2", address: "102 Example St", priorityScore: 70, topMatchFit: 70 });
  L.l3 = await makeLead(db, o, { displayName: "Pipeline owner 3", address: "103 Example St", topMatchFit: 50 });
  L.l4 = await makeLead(db, o, { displayName: "Pipeline owner 4", address: "104 Example St", priorityScore: 60 });
  L.l5 = await makeLead(db, o, { displayName: "Pipeline owner 5", address: "105 Example St", priorityScore: 95 });

  await setField(db, o, L.l1, "Property Zip Code", { valueText: "11215" });
  await setField(db, o, L.l2, "Property Zip Code", { valueText: "10013" });
  await setField(db, o, L.l4, "Property Zip Code", { valueText: "11004" });
  await setField(db, o, L.l3, "Property City", { valueText: "Astoria" });
  await setField(db, o, L.l1, "Property Type", { valueText: "Duplex" });
  await setField(db, o, L.l2, "Property Type", { valueText: "Triplex" });
  await setField(db, o, L.l3, "Property Type", { valueText: "Single Family Residence" });
  await setField(db, o, L.l4, "Property Type", { valueText: "Apartment House (5+ Units)" });
  await setField(db, o, L.l1, "Last Contacted Date", { valueDate: new Date("2026-10-11T00:00:00Z") }, "date"); // NY wall clock
  await db.dealFlowDerivedSignal.create({
    data: {
      organizationId: o, mojoId: `${TAG}_sig_l1`,
      dealflowRawJson: { crmLeadId: L.l1, buyers: [{ matchId: "m_p1", score: 88, type: "opportunity", name: "Agent Pipeline", brokerage: "Example Realty", isTestData: true, phone: "+12125550188" }] },
    },
  });

  const activity = (leadId: string, type: string, days: number) =>
    db.activity.create({ data: { organizationId: o, leadId, type, activityAt: daysBefore(NOW, days), bodyText: type === "Group" ? "Added to Hot" : null } });
  await activity(L.l1, "Call", 20);
  await activity(L.l2, "Call", 45);
  await activity(L.l4, "Email", 70);
  await activity(L.l3, "Group", 1); // a group label is not contact

  const task = (leadId: string, text: string, dueDate: string, isComplete = false) =>
    db.task.create({ data: { organizationId: o, leadId, type: "todo", text, dueDate: new Date(dueDate), isComplete } });
  await task(L.l1, "Call back", "2026-10-14T18:00:00Z"); // today, 2pm New York
  await task(L.l1, "Send comps", "2026-10-20T15:00:00Z"); // next week
  await task(L.l1, "Old one", "2026-10-01T15:00:00Z", true); // done: ignored
  await task(L.l2, "Overdue", "2026-10-10T15:00:00Z");
  await task(L.l3, "Friday", "2026-10-16T15:00:00Z"); // this week

  G.hot = (await createGroup(o, { name: "Hot", color: "red" }, db)).group.id;
  G.nurture = (await createGroup(o, { name: "Nurture", color: "green" }, db)).group.id;
  G.appt = (await createGroup(o, { name: "Appointment Set", color: "blue" }, db)).group.id;
  const member = (groupId: string, leadId: string, days: number) =>
    db.leadGroupMembership.create({ data: { groupId, leadId, addedAt: daysBefore(NOW, days), addedBy: "manual" } });
  await member(G.hot, L.l1, 100);
  await member(G.nurture, L.l1, 10);
  await member(G.hot, L.l2, 40);
  await member(G.nurture, L.l3, 5);
  await member(G.appt, L.l4, 1);

  folder = (await createFolder(o, { name: "Expireds" }, db)).id;
  lists.x = (await createList(o, { name: "X", folderId: folder, leadIds: [L.l1, L.l4, L.l5] }, db)).list.id;
  lists.y = (await createList(o, { name: "Y", leadIds: [L.l2] }, db)).list.id;
  lists.z = (await createList(o, { name: "Z", folderId: folder, leadIds: [L.l3] }, db)).list.id;
  await updateList(o, lists.z, { archived: true }, db);
});

afterAll(async () => {
  if (o) await dropOrg(db, o);
  if (other) await dropOrg(db, other);
  await db?.$disconnect();
});

describe("Pipeline table [brief §5.6]", () => {
  it("one row per lead in any shown group, in All-leads rank order (rank = position in All leads)", async () => {
    const t = await table();
    expect(t).toMatchObject({ view: "table", total: 4, page: 1, pageSize: 100 });
    expect(names(t)).toEqual(["Pipeline owner 1", "Pipeline owner 2", "Pipeline owner 4", "Pipeline owner 3"]);
    expect(t.rows.map((r) => r.rank)).toEqual([2, 3, 4, 5]); // owner 5 is #1 in All leads but in no group
    const r1 = t.rows[0];
    expect(r1.groups.map((g) => g.name)).toEqual(["Hot", "Nurture"]); // one row, both chips
    expect(r1).toMatchObject({
      leadId: L.l1, address: "101 Example St", value: null,
      bestBuyer: { name: "Agent Pipeline · Example Realty", score: 88, isTestData: true },
      lastContactAt: "2026-10-11T04:00:00.000Z",
      nextTask: { text: "Call back", dueDate: "2026-10-14T18:00:00.000Z" },
      inGroupSince: daysBefore(NOW, 100).toISOString(),
    });
    expect(t.rows.find((r) => r.leadId === L.l3)?.lastContactAt).toBeNull(); // Group entries never count
    expect(t.rows.find((r) => r.leadId === L.l2)?.bestBuyer).toBeNull();
    expect(JSON.stringify(t)).not.toMatch(/5550188/); // never a phone
    expect(t.filterOptions.propertyTypes).toEqual(["Apartment House (5+ Units)", "Duplex", "Single Family Residence", "Triplex"]);
    expect(t.filterOptions.boroughs).toEqual(["Manhattan", "Brooklyn", "Queens", "Bronx", "Staten Island"]);
    expect(t.filterOptions.neighborhoods).toContain("Park Slope");
  });

  it.each<[string, PipelineFilters, string[]]>([
    ["list", { list: "x" }, ["Pipeline owner 1", "Pipeline owner 4"]],
    ["list (archived, chosen explicitly)", { list: "z" }, ["Pipeline owner 3"]],
    ["folder (its active lists)", { folder: "f" }, ["Pipeline owner 1", "Pipeline owner 4"]],
    ["borough Brooklyn", { borough: "Brooklyn" }, ["Pipeline owner 1"]],
    ["borough Manhattan", { borough: "Manhattan" }, ["Pipeline owner 2"]],
    ["borough Queens (ZIP 11004, city Astoria)", { borough: "Queens" }, ["Pipeline owner 4", "Pipeline owner 3"]],
    ["neighborhood", { neighborhood: "Park Slope" }, ["Pipeline owner 1"]],
    ["neighborhood Tribeca", { neighborhood: "Tribeca" }, ["Pipeline owner 2"]],
    ["property type", { propertyType: "Duplex" }, ["Pipeline owner 1"]],
    ["units 1", { units: "1" }, ["Pipeline owner 3"]],
    ["units 2", { units: "2" }, ["Pipeline owner 1"]],
    ["units 3", { units: "3" }, ["Pipeline owner 2"]],
    ["units 4", { units: "4" }, []],
    ["units 5+", { units: "5+" }, ["Pipeline owner 4"]],
    ["tier hot", { tier: "hot" }, ["Pipeline owner 1"]],
    ["tier warm", { tier: "warm" }, ["Pipeline owner 2"]],
    ["tier possible", { tier: "possible" }, ["Pipeline owner 3"]],
    ["tier none", { tier: "none" }, ["Pipeline owner 4"]],
    ["strong buyer", { strongBuyer: "1" }, ["Pipeline owner 1"]],
    ["last contact never", { lastContact: "never" }, ["Pipeline owner 3"]],
    ["last contact over 7 days", { lastContact: "over7" }, ["Pipeline owner 2", "Pipeline owner 4"]],
    ["last contact over 30 days", { lastContact: "over30" }, ["Pipeline owner 2", "Pipeline owner 4"]],
    ["last contact over 60 days", { lastContact: "over60" }, ["Pipeline owner 4"]],
    ["last contact over 90 days", { lastContact: "over90" }, []],
    ["task due today", { taskDue: "today" }, ["Pipeline owner 1"]],
    ["task due this week", { taskDue: "week" }, ["Pipeline owner 1", "Pipeline owner 3"]],
    ["task overdue", { taskDue: "overdue" }, ["Pipeline owner 2"]],
    ["time in group 30+ days (any shown group)", { timeInGroup: "30" }, ["Pipeline owner 1", "Pipeline owner 2"]],
    ["time in group 60+ days", { timeInGroup: "60" }, ["Pipeline owner 1"]],
    ["time in group 90+ days", { timeInGroup: "90" }, ["Pipeline owner 1"]],
    ["in more than one group", { multiGroup: "1" }, ["Pipeline owner 1"]],
    ["search", { q: "owner 2" }, ["Pipeline owner 2"]],
    ["two filters together", { borough: "Queens", units: "5+" }, ["Pipeline owner 4"]],
  ])("filter: %s", async (_label, filters, expected) => {
    const resolved: PipelineFilters = { ...filters };
    if (filters.list) resolved.list = lists[filters.list as "x" | "y" | "z"];
    if (filters.folder) resolved.folder = folder;
    const t = await table(resolved);
    expect(names(t)).toEqual(expected);
    expect(t.total).toBe(expected.length);
  });

  it.each<[string, "asc" | "desc", string[]]>([
    ["rank", "desc", ["Pipeline owner 3", "Pipeline owner 4", "Pipeline owner 2", "Pipeline owner 1"]],
    ["name", "asc", ["Pipeline owner 1", "Pipeline owner 2", "Pipeline owner 3", "Pipeline owner 4"]],
    ["lastContact", "desc", ["Pipeline owner 1", "Pipeline owner 2", "Pipeline owner 4", "Pipeline owner 3"]],
    ["taskDue", "asc", ["Pipeline owner 2", "Pipeline owner 1", "Pipeline owner 3", "Pipeline owner 4"]],
    ["inGroupSince", "asc", ["Pipeline owner 1", "Pipeline owner 2", "Pipeline owner 3", "Pipeline owner 4"]],
  ])("sort by %s %s (blanks last)", async (sort, dir, expected) => {
    expect(names(await table({}, { sort: sort as never, dir }))).toEqual(expected);
  });

  it("shows only the chosen groups; unknown and other-org group ids are ignored", async () => {
    const otherGroup = (await createGroup(other, { name: "Theirs" }, db)).group.id;
    const t = await table({}, { groups: [G.appt, "no_such_group", otherGroup] });
    expect(names(t)).toEqual(["Pipeline owner 4"]);
    expect((await table({}, { groups: ["no_such_group"] })).rows).toEqual([]);
  });
});

describe("Pipeline board [brief §5.6]", () => {
  it("one column per group in sidebar order, with counts, rank-ordered cards and 'also in' marks", async () => {
    const b = await board({}, { groups: [G.nurture, G.appt, G.hot] }); // asked out of order
    expect(b.view).toBe("board");
    expect(b.columns.map((c) => [c.group.name, c.count, c.hasMore])).toEqual([
      ["Hot", 2, false], ["Nurture", 2, false], ["Appointment Set", 1, false],
    ]);
    const hot = b.columns[0];
    expect(hot.cards.map((c) => c.displayName)).toEqual(["Pipeline owner 1", "Pipeline owner 2"]);
    expect(hot.cards[0]).toMatchObject({
      leadId: L.l1, rank: 2, value: null, alsoIn: [{ id: G.nurture, name: "Nurture" }],
      bestBuyer: { name: "Agent Pipeline · Example Realty", score: 88, isTestData: true },
      inGroupSince: daysBefore(NOW, 100).toISOString(), lastContactAt: "2026-10-11T04:00:00.000Z",
      nextTask: { text: "Call back", dueDate: "2026-10-14T18:00:00.000Z" },
    });
    expect(hot.cards[0].groups.map((g) => g.name)).toEqual(["Hot", "Nurture"]);
    expect(hot.cards[1].alsoIn).toEqual([]);
    const nurture = b.columns[1];
    expect(nurture.cards.map((c) => c.displayName)).toEqual(["Pipeline owner 1", "Pipeline owner 3"]);
    expect(nurture.cards[0]).toMatchObject({ alsoIn: [{ id: G.hot, name: "Hot" }], inGroupSince: daysBefore(NOW, 10).toISOString() });
  });

  it("defaults to every group; filters apply per column (time in group = that column's group)", async () => {
    expect((await board()).columns.map((c) => c.group.name)).toEqual(["Hot", "Nurture", "Appointment Set"]);
    const b = await board({ timeInGroup: "30" });
    expect(b.columns.map((c) => [c.group.name, c.cards.map((x) => x.displayName)])).toEqual([
      ["Hot", ["Pipeline owner 1", "Pipeline owner 2"]], ["Nurture", []], ["Appointment Set", []],
    ]);
    expect((await board({ multiGroup: "1" })).columns.map((c) => c.count)).toEqual([1, 1, 0]);
  });

  it("50 cards per column page; column + page loads more of one column", async () => {
    const p = await makeOrg(db, `${TAG}_board`);
    try {
      await db.lead.createMany({ data: Array.from({ length: 55 }, (_, i) => ({ organizationId: p, displayName: `Board owner ${i}`, priorityScore: 100 - i })) });
      const ids = (await db.lead.findMany({ where: { organizationId: p }, orderBy: { priorityScore: "desc" }, select: { id: true } })).map((l) => l.id);
      const big = (await createGroup(p, { name: "Big" }, db)).group.id;
      const small = (await createGroup(p, { name: "Small" }, db)).group.id;
      await addGroupMembers(p, big, ids, db);
      await addGroupMembers(p, small, ids.slice(0, 2), db);
      const first = (await getPipeline(p, { view: "board", filters: {} }, { now: NOW }, db)) as PipelineBoard;
      expect(first.columns.map((c) => [c.count, c.cards.length, c.hasMore])).toEqual([[55, 50, true], [2, 2, false]]);
      expect(first.columns[0].cards.map((c) => c.rank)).toEqual(Array.from({ length: 50 }, (_, i) => i + 1));
      const more = (await getPipeline(p, { view: "board", filters: {}, column: big, page: 2 }, { now: NOW }, db)) as PipelineBoard;
      expect(more.columns).toHaveLength(1);
      expect(more.columns[0]).toMatchObject({ count: 55, hasMore: false, page: 2 });
      expect(more.columns[0].cards.map((c) => c.leadId)).toEqual(ids.slice(50));
    } finally {
      await dropOrg(db, p);
    }
  });

  it("another org's groups never show: asking for them gives an empty board", async () => {
    const b = (await getPipeline(other, { view: "board", filters: {}, groups: [G.hot] }, { now: NOW }, db)) as PipelineBoard;
    expect(b.columns).toEqual([]);
  });
});

describe("Pipeline query string [CONTRACT §6b]", () => {
  it("parses every filter and refuses unknown values", () => {
    const q = parsePipelineQuery(new URLSearchParams(
      "view=table&groups=a,b&list=l&folder=f&borough=queens&neighborhood=Park%20Slope&propertyType=Duplex&units=5%2B&tier=warm&strongBuyer=1&lastContact=over30&taskDue=week&timeInGroup=60&multiGroup=1&q=ex&page=2&sort=taskDue&dir=desc",
    ));
    expect(q).toEqual({
      view: "table", groups: ["a", "b"], page: 2, sort: "taskDue", dir: "desc", column: undefined,
      filters: { list: "l", folder: "f", borough: "Queens", neighborhood: "Park Slope", propertyType: "Duplex", units: "5+", tier: "warm", strongBuyer: "1", lastContact: "over30", taskDue: "week", timeInGroup: "60", multiGroup: "1", q: "ex" },
    });
    expect(parsePipelineQuery(new URLSearchParams(""))).toMatchObject({ view: "board", groups: undefined, page: 1, filters: {} });
    expect(parsePipelineQuery(new URLSearchParams(`q=${"x".repeat(300)}`)).filters.q).toHaveLength(200); // like list pages
    for (const bad of ["view=list", "tier=scorching", "units=6", "lastContact=over5", "taskDue=tomorrow", "timeInGroup=10", "sort=priority", "dir=up", "borough=Jersey", "value=1000000"]) {
      expect(() => parsePipelineQuery(new URLSearchParams(bad))).toThrow();
    }
  });
});

describe("saved workflows (SavedView type 'pipeline')", () => {
  it("create, list, rename, update, delete; names unique per org; unknown groups dropped", async () => {
    const otherGroup = (await db.leadGroup.findFirst({ where: { organizationId: other } }))?.id ?? (await createGroup(other, { name: "Theirs too" }, db)).group.id;
    const wf = await createWorkflow(o, {
      name: " Brownstone nurtures ", view: "board", filters: { borough: "Brooklyn", multiGroup: "1" },
      groupIds: [G.hot, G.nurture, "no_such_group", otherGroup],
    }, db);
    expect(wf).toEqual({ id: expect.any(String), name: "Brownstone nurtures", view: "board", filters: { borough: "Brooklyn", multiGroup: "1" }, groupIds: [G.hot, G.nurture], sort: null });
    const row = await db.savedView.findUniqueOrThrow({ where: { id: wf.id } });
    expect(row).toMatchObject({ organizationId: o, type: "pipeline", name: "Brownstone nurtures", sQuery: { version: 1, view: "board", filters: { borough: "Brooklyn", multiGroup: "1" } }, selectedFields: [G.hot, G.nurture] });

    await expect(createWorkflow(o, { name: "brownstone NURTURES", view: "table", filters: {}, groupIds: [] }, db)).rejects.toEqual(
      err(409, 'A workflow named "Brownstone nurtures" already exists.'),
    );
    await expect(createWorkflow(o, { name: "Bad filter", view: "board", filters: { tier: "scorching" } as never, groupIds: [] }, db)).rejects.toEqual(err(400));
    await expect(createWorkflow(o, { name: "Bad key", view: "board", filters: { estate: "1" } as never, groupIds: [] }, db)).rejects.toEqual(err(400));
    await expect(createWorkflow(o, { name: "", view: "board", filters: {}, groupIds: [] }, db)).rejects.toEqual(err(400, "Name must be 1–60 characters."));

    const second = await createWorkflow(o, { name: "Expired hot leads", view: "table", filters: { list: lists.x }, groupIds: [G.hot], sort: { key: "lastContact", dir: "desc" } }, db);
    expect((await listWorkflows(o, db)).map((w) => w.name)).toEqual(["Brownstone nurtures", "Expired hot leads"]);
    expect((await getSidebar(o, db)).workflows.map((w) => w.id)).toEqual([wf.id, second.id]);

    const updated = await updateWorkflow(o, wf.id, { name: "Brownstones", view: "table", sort: { key: "name", dir: "asc" } }, db);
    expect(updated).toMatchObject({ name: "Brownstones", view: "table", sort: { key: "name", dir: "asc" }, filters: { borough: "Brooklyn", multiGroup: "1" } });
    await expect(updateWorkflow(o, second.id, { name: "BROWNSTONES" }, db)).rejects.toEqual(err(409));
    await expect(updateWorkflow(other, wf.id, { name: "Stolen" }, db)).rejects.toEqual(err(404, "Workflow not found."));

    expect(await deleteWorkflow(o, wf.id, db)).toEqual({ deleted: true });
    await expect(deleteWorkflow(o, wf.id, db)).rejects.toEqual(err(404, "Workflow not found."));
    expect((await listWorkflows(o, db)).map((w) => w.id)).toEqual([second.id]);
  });

  it("workflows ignore lead Smart Views, and a malformed pipeline row still lists (with defaults)", async () => {
    await db.savedView.create({ data: { organizationId: o, name: "A lead view", type: "lead", sQuery: { type: "match_all" } } });
    const broken = await db.savedView.create({ data: { organizationId: o, name: "Broken workflow", type: "pipeline", sQuery: { type: "match_all" } } });
    const all = await listWorkflows(o, db);
    expect(all.map((w) => w.name)).not.toContain("A lead view");
    expect(all.find((w) => w.id === broken.id)).toEqual({ id: broken.id, name: "Broken workflow", view: "board", filters: {}, groupIds: [], sort: null });
  });

  it("Smart View code never parses a workflow as a lead view", async () => {
    const wf = await createWorkflow(o, { name: "Not a smart view", view: "board", filters: {}, groupIds: [] }, db);
    const r = await listLeads({ organizationId: o, viewId: wf.id, pageSize: 50 }, db);
    expect(r.viewError).toMatch(/type must be 'lead'/);
    expect(r.total).toBe(5); // falls back to every lead
  });
});
