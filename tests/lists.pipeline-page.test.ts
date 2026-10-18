import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { PrismaClient } from "@prisma/client";
import { prismaPerf } from "./setup/pg";
import { makeOrg, dropOrg, makeLead, setField, daysBefore } from "./setup/b45";
import { createFolder } from "@/lib/core-data/lists/folders";
import { createList, deleteList, updateList } from "@/lib/core-data/lists/lists";
import { createGroup, addGroupMembers, deleteGroup } from "@/lib/core-data/lists/groups";
import { createWorkflow } from "@/lib/core-data/lists/workflows";
import { getPipeline } from "@/lib/core-data/lists/pipeline";
import type { PipelineBoard, PipelineTable } from "@/lib/core-data/lists/types";
import { loadPipelinePage } from "@/app/pipeline/load";

// Brief 45 PR D — what the /pipeline page loads on the server for a URL:
// the effective query (a workflow tab, the link's filters), the board or
// table from PR A's query, and plain notes for anything in the link that no
// longer exists. The page must always open: a deleted group, list or
// workflow, or a filter it doesn't know, never breaks it. Made-up leads only.
const TAG = `b45d_${Date.now()}`;
const NOW = new Date("2026-10-14T16:00:00Z");
let db: PrismaClient;
let o: string;
let empty: string;
let other: string;
const G: Record<"hot" | "nurture" | "appt" | "gone", string> = { hot: "", nurture: "", appt: "", gone: "" };
const L: Record<"a" | "b" | "c", string> = { a: "", b: "", c: "" };
let listKept = "";
let listArchived = "";
let listDeleted = "";
let folder = "";
let theirs = "";

const load = (search: string, org = () => o) => loadPipelinePage(org(), new URLSearchParams(search), { now: NOW }, db);
const columnNames = (r: Awaited<ReturnType<typeof load>>) => (r.result as PipelineBoard).columns.map((c) => c.group.name);

beforeAll(async () => {
  db = prismaPerf(2);
  await db.$connect();
  o = await makeOrg(db, TAG);
  empty = await makeOrg(db, `${TAG}_empty`);
  other = await makeOrg(db, `${TAG}_other`);

  L.a = await makeLead(db, o, { displayName: "Page owner A", address: "201 Example St", priorityScore: 90, topMatchFit: 85 });
  L.b = await makeLead(db, o, { displayName: "Page owner B", address: "202 Example St", priorityScore: 70, topMatchFit: 66 });
  L.c = await makeLead(db, o, { displayName: "Page owner C", address: "203 Example St", priorityScore: 50 });
  await setField(db, o, L.a, "Property Zip Code", { valueText: "11215" });
  await setField(db, o, L.b, "Property Zip Code", { valueText: "11385" });

  G.hot = (await createGroup(o, { name: "Hot", color: "red" }, db)).group.id;
  G.nurture = (await createGroup(o, { name: "Nurture", color: "green" }, db)).group.id;
  G.appt = (await createGroup(o, { name: "Appointment Set", color: "blue" }, db)).group.id;
  G.gone = (await createGroup(o, { name: "Soon deleted" }, db)).group.id;
  await addGroupMembers(o, G.hot, [L.a, L.b], db);
  await addGroupMembers(o, G.nurture, [L.a, L.c], db);
  await addGroupMembers(o, G.appt, [L.c], db);

  folder = (await createFolder(o, { name: "Expireds" }, db)).id;
  listKept = (await createList(o, { name: "Kept", folderId: folder, leadIds: [L.a] }, db)).list.id;
  listArchived = (await createList(o, { name: "Old", folderId: folder, leadIds: [L.b] }, db)).list.id;
  await updateList(o, listArchived, { archived: true }, db);
  listDeleted = (await createList(o, { name: "Gone", leadIds: [L.c] }, db)).list.id;
  theirs = (await createGroup(other, { name: "Theirs" }, db)).group.id;
});

afterAll(async () => {
  for (const org of [o, empty, other]) if (org) await dropOrg(db, org);
  await db?.$disconnect();
});

describe("loadPipelinePage", () => {
  it("no groups yet: nothing to query, the page shows the empty state", async () => {
    const r = await load("", () => empty);
    expect(r).toMatchObject({ groups: [], result: null, workflows: [], notices: [], workflowId: null, now: NOW.toISOString() });
  });

  it("the default view: every group as a column, in sidebar order, from PR A's query", async () => {
    const r = await load("");
    expect(r.query).toEqual({ view: "board", filters: {} });
    expect(columnNames(r)).toEqual(["Hot", "Nurture", "Appointment Set", "Soon deleted"]);
    expect(r.result).toEqual(await getPipeline(o, { view: "board", filters: {} }, { now: NOW }, db));
    expect(r.groups.map((g) => g.name)).toEqual(["Hot", "Nurture", "Appointment Set", "Soon deleted"]);
    expect(r.lists.map((l) => l.name)).toEqual(["Kept", "Gone"]);
    expect(r.archivedLists.map((l) => l.name)).toEqual(["Old"]);
    expect(r.folders.map((f) => f.name)).toEqual(["Expireds"]);
  });

  it("filters from the link apply (the table, a borough, a sort)", async () => {
    const r = await load("view=table&borough=brooklyn&sort=name&dir=desc");
    expect(r.query).toEqual({ view: "table", filters: { borough: "Brooklyn" }, sort: "name", dir: "desc" });
    expect((r.result as PipelineTable).rows.map((x) => x.displayName)).toEqual(["Page owner A"]);
  });

  it("a workflow tab (?wf=id alone) opens with its saved filters, columns, view and sort", async () => {
    const wf = await createWorkflow(o, { name: "Hot table", view: "table", filters: { tier: "hot" }, groupIds: [G.hot], sort: { key: "name", dir: "asc" } }, db);
    const r = await load(`wf=${wf.id}`);
    expect(r.workflowId).toBe(wf.id);
    expect(r.query).toEqual({ view: "table", groups: [G.hot], filters: { tier: "hot" }, sort: "name" });
    expect((r.result as PipelineTable).rows.map((x) => x.displayName)).toEqual(["Page owner A"]);
    expect(r.notices).toEqual([]);
    // Anything else in the link is what's on screen now (the tab shows "Unsaved changes").
    const changed = await load(`wf=${wf.id}&view=board`);
    expect(changed).toMatchObject({ workflowId: wf.id, query: { view: "board", filters: {} } });
  });

  it("a workflow whose group was deleted still opens: the rest of its groups, or every group", async () => {
    const wf = await createWorkflow(o, { name: "Two columns", view: "board", filters: {}, groupIds: [G.nurture, G.gone] }, db);
    const lone = await createWorkflow(o, { name: "One column", view: "board", filters: { borough: "Queens" }, groupIds: [G.gone] }, db);
    await deleteGroup(o, G.gone, db);

    const r = await load(`wf=${wf.id}`);
    expect(columnNames(r)).toEqual(["Nurture"]);
    expect(r.query.groups).toEqual([G.nurture]);
    expect(r.notices).toEqual(["A group this workflow showed was deleted, so its column is gone."]);

    const all = await load(`wf=${lone.id}`);
    expect(all.query).toEqual({ view: "board", filters: { borough: "Queens" } });
    expect(columnNames(all)).toEqual(["Hot", "Nurture", "Appointment Set"]);
    expect(all.notices).toEqual(["The group this workflow showed was deleted, so it shows every group now."]);
  });

  it("a link to a deleted or another org's group (e.g. an old sidebar link) shows every group, and says so", async () => {
    const r = await load(`groups=${theirs}`);
    expect(r.query.groups).toBeUndefined();
    expect(columnNames(r)).toEqual(["Hot", "Nurture", "Appointment Set"]);
    expect(r.notices).toEqual(["The group in this link no longer exists, so every group is shown."]);
    const some = await load(`groups=${G.hot},${theirs}`);
    expect(columnNames(some)).toEqual(["Hot"]);
    expect(some.notices).toEqual(["A group in this link no longer exists, so its column is left out."]);
  });

  it("a deleted list or folder in the filters is dropped with a note; an archived list still filters", async () => {
    await deleteList(o, listDeleted, db);
    const gone = await load(`list=${listDeleted}&view=table`);
    expect(gone.query.filters).toEqual({});
    expect(gone.notices).toEqual(["The list in this view was deleted, so that filter was removed."]);
    const unknownFolder = await load("folder=f_nope");
    expect(unknownFolder.query.filters).toEqual({});
    expect(unknownFolder.notices).toEqual(["The folder in this view was deleted, so that filter was removed."]);
    const archived = await load(`list=${listArchived}&view=table`);
    expect(archived.query.filters).toEqual({ list: listArchived });
    expect((archived.result as PipelineTable).rows.map((x) => x.displayName)).toEqual(["Page owner B"]);
    expect(archived.notices).toEqual([]);
    const kept = await load(`folder=${folder}&view=table`);
    expect((kept.result as PipelineTable).rows.map((x) => x.displayName)).toEqual(["Page owner A"]);
  });

  it("an unknown or another org's workflow: a note and the default view", async () => {
    const theirsWf = await createWorkflow(other, { name: "Not yours", view: "table", filters: {}, groupIds: [] }, db);
    for (const id of ["wf_missing", theirsWf.id]) {
      const r = await load(`wf=${id}`);
      expect(r).toMatchObject({ workflowId: null, query: { view: "board", filters: {} }, notices: ["That saved workflow no longer exists."] });
    }
    expect((await load("")).workflows.map((w) => w.name)).not.toContain("Not yours");
  });

  it("a link with filters it doesn't know still opens, without them, and says what was ignored", async () => {
    const r = await load("tier=scorching&value=900000&units=5%2B");
    expect(r.query.filters).toEqual({ units: "5+" });
    expect(r.notices).toEqual([
      "This link had a DealFlow tier the Pipeline doesn't know (scorching), so it was ignored.",
      "Filtering by value isn't available yet: our estimates aren't in the CRM.",
    ]);
    expect(r.result?.view).toBe("board");
  });

  it("time in group and 'in more than one group' reach PR A's query per column", async () => {
    await db.leadGroupMembership.updateMany({ where: { groupId: G.hot, leadId: L.a }, data: { addedAt: daysBefore(NOW, 45) } });
    const r = await load("timeInGroup=30&multiGroup=1");
    const board = r.result as PipelineBoard;
    expect(board.columns.map((c) => [c.group.name, c.cards.map((x) => x.displayName)])).toEqual([
      ["Hot", ["Page owner A"]], ["Nurture", []], ["Appointment Set", []],
    ]);
    expect(board.columns[0].cards[0].alsoIn.map((g) => g.name)).toEqual(["Nurture"]);
  });
});
