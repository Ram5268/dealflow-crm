import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { Prisma, type PrismaClient } from "@prisma/client";
import { prismaPerf } from "./setup/pg";
import { makeOrg, dropOrg, makeLead } from "./setup/b45";
import { createFolder, renameFolder, deleteFolder, reorderFolders } from "@/lib/core-data/lists/folders";
import { createList, updateList, deleteList, reorderLists, listLists } from "@/lib/core-data/lists/lists";
import {
  createGroup, updateGroup, deleteGroup, reorderGroups, listGroups,
  addLeadToGroup, removeLeadFromGroup, addGroupMembers, removeGroupMembers, moveLeadBetweenGroups,
} from "@/lib/core-data/lists/groups";
import { addListMembers, removeListMembers, getLeadMemberships } from "@/lib/core-data/lists/memberships";
import { getSidebar } from "@/lib/core-data/lists/sidebar";
import { getRankedIds } from "@/lib/core-data/lists/ranked";

// Brief 45 PR A — folders, lists, groups and memberships against a real
// Postgres (CI's db-suite), inside throwaway organizations. Made-up leads only.
const TAG = `b45s_${Date.now()}`;
let db: PrismaClient;
let org: string;
let other: string; // a second organization: its ids must behave like unknown ids

const err = (status: number, message?: string | RegExp) =>
  message === undefined ? expect.objectContaining({ status }) : expect.objectContaining({ status, message: message instanceof RegExp ? expect.stringMatching(message) : message });

async function leads(n: number, prefix = "Test Owner"): Promise<string[]> {
  const ids: string[] = [];
  for (let i = 0; i < n; i++) ids.push(await makeLead(db, org, { displayName: `${prefix} ${i}` }));
  return ids;
}

const groupActivities = (leadId: string) =>
  db.activity.findMany({ where: { organizationId: org, leadId, type: "Group" }, orderBy: [{ activityAt: "asc" }, { id: "asc" }] });
// Entries written by separate calls can share a millisecond, so compare them as a sorted set.
const groupEntries = async (leadId: string) => (await groupActivities(leadId)).map((a) => a.bodyText).sort();

beforeAll(async () => {
  db = prismaPerf(4);
  await db.$connect();
  org = await makeOrg(db, TAG);
  other = await makeOrg(db, `${TAG}_other`);
});

afterAll(async () => {
  if (org) await dropOrg(db, org);
  if (other) await dropOrg(db, other);
  await db?.$disconnect();
});

describe("names [Ryan 2026-10-18; brief §5.1]", () => {
  it("folder names are unique per org, case-insensitively and trimmed", async () => {
    const f = await createFolder(org, { name: "  Expireds  " }, db);
    expect(f.name).toBe("Expireds");
    await expect(createFolder(org, { name: "expireds" }, db)).rejects.toEqual(err(409, 'A folder named "Expireds" already exists.'));
    await expect(createFolder(org, { name: " EXPIREDS " }, db)).rejects.toEqual(err(409));
    // Renaming to its own name in another case is not a clash with itself.
    expect((await renameFolder(org, f.id, { name: "EXPIREDS" }, db)).name).toBe("EXPIREDS");
    // Another org may use the same name.
    expect((await createFolder(other, { name: "Expireds" }, db)).name).toBe("Expireds");
  });

  it("names must be 1–60 characters after trimming (NFC)", async () => {
    for (const name of ["", "   ", "x".repeat(61), 42, null]) {
      await expect(createFolder(org, { name }, db)).rejects.toEqual(err(400, "Name must be 1–60 characters."));
      await expect(createGroup(org, { name }, db)).rejects.toEqual(err(400, "Name must be 1–60 characters."));
      await expect(createList(org, { name }, db)).rejects.toEqual(err(400, "Name must be 1–60 characters."));
    }
    expect((await createFolder(org, { name: "y".repeat(60) }, db)).name).toHaveLength(60);
    // "é" typed as e + combining accent is the same name as the precomposed é.
    const a = await createGroup(org, { name: "Café" }, db);
    await expect(createGroup(org, { name: "Café" }, db)).rejects.toEqual(err(409, 'A group named "Café" already exists.'));
    await deleteGroup(org, a.group.id, db);
  });

  it("list names are unique within a folder, and separately among lists outside folders; archived lists count", async () => {
    const f1 = await createFolder(org, { name: "Off-market" }, db);
    const f2 = await createFolder(org, { name: "Referrals folder" }, db);
    const inF1 = await createList(org, { name: "Brownstones", folderId: f1.id }, db);
    await expect(createList(org, { name: "brownstones", folderId: f1.id }, db)).rejects.toEqual(
      err(409, 'A list named "Brownstones" is already in this folder.'),
    );
    // Same name in another folder, and outside folders: both fine.
    await createList(org, { name: "Brownstones", folderId: f2.id }, db);
    const outside = await createList(org, { name: "Brownstones", folderId: null }, db);
    await expect(createList(org, { name: "BROWNSTONES" }, db)).rejects.toEqual(
      err(409, 'A list named "Brownstones" is already outside folders.'),
    );
    // Archived lists still hold their name, so unarchiving can never make a duplicate.
    await updateList(org, inF1.list.id, { archived: true }, db);
    await expect(createList(org, { name: "Brownstones", folderId: f1.id }, db)).rejects.toEqual(err(409));
    expect((await updateList(org, inF1.list.id, { archived: false }, db)).archivedAt).toBeNull();
    // Moving a list into a folder that already has that name is refused; nothing changes.
    await expect(updateList(org, outside.list.id, { folderId: f1.id }, db)).rejects.toEqual(
      err(409, 'A list named "Brownstones" is already in this folder.'),
    );
    expect((await db.callList.findUniqueOrThrow({ where: { id: outside.list.id } })).folderId).toBeNull();
  });

  it("group names are unique per org", async () => {
    await createGroup(org, { name: "Hot" }, db);
    await expect(createGroup(org, { name: " hot" }, db)).rejects.toEqual(err(409, 'A group named "Hot" already exists.'));
    const warm = await createGroup(org, { name: "Warm" }, db);
    await expect(updateGroup(org, warm.group.id, { name: "HOT" }, db)).rejects.toEqual(err(409, 'A group named "Hot" already exists.'));
  });

  it("two simultaneous creates with one name: exactly one wins (advisory lock)", async () => {
    const results = await Promise.allSettled([
      createFolder(org, { name: "Race" }, db),
      createFolder(org, { name: "race" }, db),
      createFolder(org, { name: "RACE " }, db),
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((r) => r.status === "rejected").map((r) => (r as PromiseRejectedResult).reason.status)).toEqual([409, 409]);
    expect(await db.folder.count({ where: { organizationId: org, name: { equals: "race", mode: "insensitive" } } })).toBe(1);
    const groups = await Promise.allSettled([createGroup(org, { name: "Same" }, db), createGroup(org, { name: "SAME" }, db)]);
    expect(groups.filter((r) => r.status === "fulfilled")).toHaveLength(1);
  });

  it("group colors are one of the fixed set", async () => {
    const g = await createGroup(org, { name: "Colored", color: "teal" }, db);
    expect(g.group.color).toBe("teal");
    expect((await createGroup(org, { name: "Default color" }, db)).group.color).toBe("gray");
    await expect(createGroup(org, { name: "Bad color", color: "#ff0000" }, db)).rejects.toEqual(err(400, /^Pick one of these colors/));
    await expect(updateGroup(org, g.group.id, { color: "chartreuse" }, db)).rejects.toEqual(err(400, /^Pick one of these colors/));
    expect((await updateGroup(org, g.group.id, { color: "pink" }, db)).color).toBe("pink");
  });
});

describe("folders hold lists only [Ryan 2026-10-18]", () => {
  it("a folder has no parent field: nesting is impossible by construction", () => {
    const folder = Prisma.dmmf.datamodel.models.find((m) => m.name === "Folder")!;
    expect(folder.fields.map((f) => f.name).sort()).toEqual(
      ["createdAt", "id", "lists", "name", "organization", "organizationId", "sortOrder", "updatedAt"],
    );
    expect(folder.fields.filter((f) => f.kind === "object").map((f) => f.type).sort()).toEqual(["CallList", "Organization"]);
    const group = Prisma.dmmf.datamodel.models.find((m) => m.name === "LeadGroup")!;
    expect(group.fields.some((f) => /folder/i.test(f.name))).toBe(false); // no groups in folders
  });

  it("a list can sit outside a folder", async () => {
    const r = await createList(org, { name: "Loose list" }, db);
    expect(r.list).toMatchObject({ folderId: null, source: "manual", memberCount: 0, archivedAt: null });
    const sidebar = await getSidebar(org, db);
    expect(sidebar.lists.find((l) => l.id === r.list.id)?.folderId).toBeNull();
  });

  it("a folder can be deleted only when empty; archived lists count", async () => {
    const f = await createFolder(org, { name: "To delete" }, db);
    const a = await createList(org, { name: "A", folderId: f.id }, db);
    const b = await createList(org, { name: "B", folderId: f.id }, db);
    const c = await createList(org, { name: "C", folderId: f.id }, db);
    await updateList(org, c.list.id, { archived: true }, db);
    await expect(deleteFolder(org, f.id, db)).rejects.toEqual(
      err(409, "This folder still has 3 lists (1 archived). Move or delete them first."),
    );
    await deleteList(org, a.list.id, db);
    await updateList(org, b.list.id, { folderId: null }, db);
    await expect(deleteFolder(org, f.id, db)).rejects.toEqual(
      err(409, "This folder still has 1 list (1 archived). Move or delete it first."),
    );
    await deleteList(org, c.list.id, db);
    expect(await deleteFolder(org, f.id, db)).toEqual({ deleted: true });
    expect(await db.folder.findUnique({ where: { id: f.id } })).toBeNull();
    await expect(deleteFolder(org, f.id, db)).rejects.toEqual(err(404, "Folder not found."));
  });

  it("moving a list into a folder puts it last there; unarchiving puts it last too", async () => {
    const f = await createFolder(org, { name: "Ordering" }, db);
    const x = await createList(org, { name: "X", folderId: f.id }, db);
    const y = await createList(org, { name: "Y", folderId: f.id }, db);
    const z = await createList(org, { name: "Z" }, db);
    expect(y.list.sortOrder).toBeGreaterThan(x.list.sortOrder);
    const moved = await updateList(org, z.list.id, { folderId: f.id }, db);
    expect(moved.folderId).toBe(f.id);
    expect(moved.sortOrder).toBeGreaterThan(y.list.sortOrder);
    await updateList(org, x.list.id, { archived: true }, db);
    const back = await updateList(org, x.list.id, { archived: false }, db);
    expect(back.sortOrder).toBeGreaterThan(moved.sortOrder);
    await expect(updateList(org, x.list.id, { folderId: "no_such_folder" }, db)).rejects.toEqual(err(404, "Folder not found."));
  });
});

describe("leads are never deleted by list or group changes [brief §5.1]", () => {
  it("deleting a list or a group removes only memberships", async () => {
    const ids = await leads(3, "Keeper");
    const list = await createList(org, { name: "Delete me", leadIds: ids }, db);
    expect(list.added).toBe(3);
    const group = await createGroup(org, { name: "Delete me too" }, db);
    expect(await addGroupMembers(org, group.group.id, ids, db)).toEqual({ added: 3, alreadyIn: 0, notFound: 0 });
    const before = await db.lead.count({ where: { organizationId: org } });

    expect(await deleteList(org, list.list.id, db)).toEqual({ deleted: true, membershipsRemoved: 3 });
    expect(await deleteGroup(org, group.group.id, db)).toEqual({ deleted: true, membershipsRemoved: 3 });
    expect(await db.lead.count({ where: { organizationId: org } })).toBe(before);
    expect(await db.lead.count({ where: { id: { in: ids } } })).toBe(3);
    expect(await db.listMembership.count({ where: { leadId: { in: ids } } })).toBe(0);
    expect(await db.leadGroupMembership.count({ where: { leadId: { in: ids } } })).toBe(0);
    // Deleting a group writes "(group deleted)" on each member's timeline.
    for (const id of ids) {
      expect(await groupEntries(id)).toEqual(["Added to Delete me too", "Removed from Delete me too (group deleted)"]);
    }
  });

  it("archiving a list keeps its members and leads", async () => {
    const ids = await leads(2, "Archived member");
    const list = await createList(org, { name: "Archive me", leadIds: ids }, db);
    const archived = await updateList(org, list.list.id, { archived: true }, db);
    expect(archived.archivedAt).not.toBeNull();
    expect(archived.memberCount).toBe(2);
    expect(await db.lead.count({ where: { id: { in: ids } } })).toBe(2);
    expect((await listLists(org, { archived: true }, db)).map((l) => l.id)).toContain(list.list.id);
    expect((await listLists(org, {}, db)).map((l) => l.id)).not.toContain(list.list.id);
  });
});

describe("memberships [Ryan 2026-10-18]", () => {
  it("adding to or removing from a group never changes list membership", async () => {
    const [a, b] = await leads(2, "Call order");
    const list = await createList(org, { name: "Call order list", leadIds: [a, b] }, db);
    const g = await createGroup(org, { name: "Nurture" }, db);
    const order = () => getRankedIds(org, list.list.id, {}, db);
    const before = await order();
    await addLeadToGroup(org, g.group.id, a, db);
    await addGroupMembers(org, g.group.id, [a, b], db);
    await moveLeadBetweenGroups(org, { leadId: b, fromGroupId: g.group.id, toGroupId: (await createGroup(org, { name: "Appointment Set" }, db)).group.id }, db);
    await removeLeadFromGroup(org, g.group.id, a, db);
    await removeGroupMembers(org, g.group.id, [a, b], db);
    expect(await order()).toEqual(before);
    expect(await db.listMembership.count({ where: { listId: list.list.id } })).toBe(2);
    // Adding them to another list doesn't take them out of this one either.
    await createList(org, { name: "Second list", leadIds: [a, b] }, db);
    expect(await order()).toEqual(before);
  });

  it("one lead on two lists and in two groups is one lead", async () => {
    const [p] = await leads(1, "Twice listed");
    const l1 = await createList(org, { name: "First of two", leadIds: [p] }, db);
    const l2 = await createList(org, { name: "Second of two", leadIds: [p] }, db);
    const g1 = await createGroup(org, { name: "Twice A" }, db);
    const g2 = await createGroup(org, { name: "Twice B" }, db);
    await addLeadToGroup(org, g1.group.id, p, db);
    await addLeadToGroup(org, g2.group.id, p, db);
    expect(await db.lead.count({ where: { id: p } })).toBe(1);
    expect(await getRankedIds(org, l1.list.id, {}, db)).toEqual([p]);
    expect(await getRankedIds(org, l2.list.id, {}, db)).toEqual([p]);
    const all = await getRankedIds(org, null, {}, db);
    expect(all.filter((id) => id === p)).toHaveLength(1);
    const m = await getLeadMemberships(org, p, db);
    expect(m.lists.map((l) => l.id).sort()).toEqual([l1.list.id, l2.list.id].sort());
    expect(m.groupIds).toEqual([g1.group.id, g2.group.id]); // sidebar order
  });

  it("single and bulk adds/removes are idempotent and report counts", async () => {
    const ids = await leads(4, "Idempotent");
    const list = await createList(org, { name: "Idempotent list" }, db);
    expect(await addListMembers(org, list.list.id, [ids[0], ids[0], ids[1]], {}, db)).toEqual({ added: 2, alreadyIn: 0, notFound: 0 });
    expect(await addListMembers(org, list.list.id, [ids[0], ids[1], ids[2], "no_such_lead"], {}, db)).toEqual({ added: 1, alreadyIn: 2, notFound: 1 });
    expect(await removeListMembers(org, list.list.id, [ids[0], ids[0], ids[3]], db)).toEqual({ removed: 1 });
    expect(await removeListMembers(org, list.list.id, [ids[0]], db)).toEqual({ removed: 0 });
    expect(await addListMembers(org, list.list.id, [], {}, db)).toEqual({ added: 0, alreadyIn: 0, notFound: 0 });

    const g = await createGroup(org, { name: "Idempotent group" }, db);
    expect(await addLeadToGroup(org, g.group.id, ids[0], db)).toEqual({ changed: true });
    expect(await addLeadToGroup(org, g.group.id, ids[0], db)).toEqual({ changed: false });
    expect(await addGroupMembers(org, g.group.id, [ids[0], ids[1], ids[1], "nope"], db)).toEqual({ added: 1, alreadyIn: 1, notFound: 1 });
    expect(await removeLeadFromGroup(org, g.group.id, ids[0], db)).toEqual({ changed: true });
    expect(await removeLeadFromGroup(org, g.group.id, ids[0], db)).toEqual({ changed: false });
    expect(await removeGroupMembers(org, g.group.id, [ids[0], ids[1], ids[1]], db)).toEqual({ removed: 1 });
    expect(await db.leadGroupMembership.count({ where: { groupId: g.group.id } })).toBe(0);
  });

  it("more than 5,000 ids in one request is refused", async () => {
    const list = await createList(org, { name: "Bulk limit" }, db);
    const g = await createGroup(org, { name: "Bulk limit" }, db);
    const tooMany = Array.from({ length: 5_001 }, (_, i) => `x${i}`);
    const exactly = tooMany.slice(0, 5_000);
    const tooBig = err(400, /5,000/);
    await expect(addListMembers(org, list.list.id, tooMany, {}, db)).rejects.toEqual(tooBig);
    await expect(removeListMembers(org, list.list.id, tooMany, db)).rejects.toEqual(tooBig);
    await expect(addGroupMembers(org, g.group.id, tooMany, db)).rejects.toEqual(tooBig);
    await expect(removeGroupMembers(org, g.group.id, tooMany, db)).rejects.toEqual(tooBig);
    await expect(createList(org, { name: "Bulk limit new", leadIds: tooMany }, db)).rejects.toEqual(tooBig);
    expect(await db.callList.count({ where: { organizationId: org, name: "Bulk limit new" } })).toBe(0);
    expect(await addListMembers(org, list.list.id, exactly, {}, db)).toEqual({ added: 0, alreadyIn: 0, notFound: 5_000 });
  });

  it("timeline entries are written only for real changes", async () => {
    const [p] = await leads(1, "Timeline");
    const hot = await createGroup(org, { name: "Timeline Hot" }, db);
    const nurture = await createGroup(org, { name: "Timeline Nurture" }, db);
    await addLeadToGroup(org, hot.group.id, p, db);
    await addLeadToGroup(org, hot.group.id, p, db); // no change
    await addGroupMembers(org, hot.group.id, [p], db); // no change
    await removeLeadFromGroup(org, nurture.group.id, p, db); // not a member: no change
    await moveLeadBetweenGroups(org, { leadId: p, fromGroupId: hot.group.id, toGroupId: nurture.group.id }, db);
    await removeGroupMembers(org, nurture.group.id, [p], db);
    await removeGroupMembers(org, nurture.group.id, [p], db); // no change
    expect(await groupEntries(p)).toEqual([
      "Added to Timeline Hot",
      "Added to Timeline Nurture",
      "Removed from Timeline Hot",
      "Removed from Timeline Nurture",
    ]);
    const entries = await groupActivities(p);
    expect(entries.every((a) => a.userId === null && a.type === "Group" && a.organizationId === org)).toBe(true);
    // List membership changes are not timeline entries.
    const before = await db.activity.count({ where: { leadId: p } });
    await createList(org, { name: "Timeline list", leadIds: [p] }, db);
    expect(await db.activity.count({ where: { leadId: p } })).toBe(before);
  });

  it("/groups/move: one transaction, two entries; refuses unknown groups and same-group moves", async () => {
    const [p, q] = await leads(2, "Mover");
    const x = await createGroup(org, { name: "Move from" }, db);
    const y = await createGroup(org, { name: "Move to" }, db);
    await addLeadToGroup(org, x.group.id, p, db);
    expect(await moveLeadBetweenGroups(org, { leadId: p, fromGroupId: x.group.id, toGroupId: y.group.id }, db)).toMatchObject({ ok: true, removed: true, added: true });
    expect((await getLeadMemberships(org, p, db)).groupIds).toEqual([y.group.id]);
    // A stale card (not in X any more, already in Y): nothing changes, no entries.
    const count = (await groupActivities(p)).length;
    expect(await moveLeadBetweenGroups(org, { leadId: p, fromGroupId: x.group.id, toGroupId: y.group.id }, db)).toMatchObject({ ok: true, removed: false, added: false });
    expect((await groupActivities(p)).length).toBe(count);
    await expect(moveLeadBetweenGroups(org, { leadId: p, fromGroupId: x.group.id, toGroupId: x.group.id }, db)).rejects.toEqual(err(400));
    await expect(moveLeadBetweenGroups(org, { leadId: p, fromGroupId: x.group.id, toGroupId: "no_such_group" }, db)).rejects.toEqual(err(404, "Group not found."));
    await expect(moveLeadBetweenGroups(org, { leadId: "no_such_lead", fromGroupId: x.group.id, toGroupId: y.group.id }, db)).rejects.toEqual(err(404, "Lead not found."));
    // q was never in X: the move still adds it to Y (one entry).
    await moveLeadBetweenGroups(org, { leadId: q, fromGroupId: x.group.id, toGroupId: y.group.id }, db);
    expect(await groupEntries(q)).toEqual(["Added to Move to"]);
  });

  it("the + chip: create a group and add the lead in one step", async () => {
    const [p] = await leads(1, "Plus chip");
    const r = await createGroup(org, { name: "Plus", color: "red", leadId: p }, db);
    expect(r).toMatchObject({ added: 1, group: { name: "Plus", color: "red", memberCount: 1 } });
    expect(await groupEntries(p)).toEqual(["Added to Plus"]);
    // An unknown lead: nothing is created.
    await expect(createGroup(org, { name: "Plus ghost", leadId: "no_such_lead" }, db)).rejects.toEqual(err(404, "Lead not found."));
    expect(await db.leadGroup.count({ where: { organizationId: org, name: "Plus ghost" } })).toBe(0);
  });
});

describe("org scoping: another org's ids behave like unknown ids", () => {
  let foreign: { folder: string; list: string; group: string; lead: string };
  let mine: { list: string; group: string; lead: string };

  beforeAll(async () => {
    const lead = await makeLead(db, other, { displayName: "Other org owner" });
    foreign = {
      folder: (await createFolder(other, { name: "Theirs" }, db)).id,
      list: (await createList(other, { name: "Theirs", leadIds: [lead] }, db)).list.id,
      group: (await createGroup(other, { name: "Theirs" }, db)).group.id,
      lead,
    };
    const myLead = await makeLead(db, org, { displayName: "Scoped owner" });
    mine = {
      list: (await createList(org, { name: "Mine scoped" }, db)).list.id,
      group: (await createGroup(org, { name: "Mine scoped" }, db)).group.id,
      lead: myLead,
    };
  });

  it("folders, lists and groups of another org are 404", async () => {
    await expect(renameFolder(org, foreign.folder, { name: "Mine now" }, db)).rejects.toEqual(err(404, "Folder not found."));
    await expect(deleteFolder(org, foreign.folder, db)).rejects.toEqual(err(404, "Folder not found."));
    await expect(updateList(org, foreign.list, { name: "Mine now" }, db)).rejects.toEqual(err(404, "List not found."));
    await expect(deleteList(org, foreign.list, db)).rejects.toEqual(err(404, "List not found."));
    await expect(updateGroup(org, foreign.group, { name: "Mine now" }, db)).rejects.toEqual(err(404, "Group not found."));
    await expect(deleteGroup(org, foreign.group, db)).rejects.toEqual(err(404, "Group not found."));
    await expect(createList(org, { name: "Into their folder", folderId: foreign.folder }, db)).rejects.toEqual(err(404, "Folder not found."));
    await expect(updateList(org, mine.list, { folderId: foreign.folder }, db)).rejects.toEqual(err(404, "Folder not found."));
    await expect(addListMembers(org, foreign.list, [mine.lead], {}, db)).rejects.toEqual(err(404, "List not found."));
    await expect(getRankedIds(org, foreign.list, {}, db)).rejects.toEqual(err(404, "List not found."));
    await expect(addLeadToGroup(org, foreign.group, mine.lead, db)).rejects.toEqual(err(404, "Group not found."));
    await expect(getLeadMemberships(org, foreign.lead, db)).rejects.toEqual(err(404, "Lead not found."));
    // Their rows are untouched.
    expect(await db.folder.count({ where: { id: foreign.folder, name: "Theirs" } })).toBe(1);
    expect(await db.listMembership.count({ where: { listId: foreign.list } })).toBe(1);
  });

  it("another org's leads count as notFound in bulk results and are never added", async () => {
    expect(await addListMembers(org, mine.list, [foreign.lead, mine.lead], {}, db)).toEqual({ added: 1, alreadyIn: 0, notFound: 1 });
    expect(await addGroupMembers(org, mine.group, [foreign.lead], db)).toEqual({ added: 0, alreadyIn: 0, notFound: 1 });
    await expect(addLeadToGroup(org, mine.group, foreign.lead, db)).rejects.toEqual(err(404, "Lead not found."));
    await expect(createGroup(org, { name: "Plus foreign", leadId: foreign.lead }, db)).rejects.toEqual(err(404, "Lead not found."));
    expect(await db.listMembership.count({ where: { leadId: foreign.lead } })).toBe(1); // only their own list
    expect(await db.leadGroupMembership.count({ where: { leadId: foreign.lead } })).toBe(0);
  });

  it("reorder refuses ids from another org", async () => {
    const mineFolders = (await getSidebar(org, db)).folders.map((f) => f.id);
    await expect(reorderFolders(org, [...mineFolders, foreign.folder], db)).rejects.toEqual(err(409));
    const mineGroups = (await listGroups(org, db)).map((g) => g.id);
    await expect(reorderGroups(org, [...mineGroups.slice(1), foreign.group], db)).rejects.toEqual(err(409));
  });
});

describe("reorder", () => {
  it("folders, lists and groups take the new order; a stale order is refused", async () => {
    const o = await makeOrg(db, `${TAG}_reorder`);
    try {
      const [f1, f2, f3] = [await createFolder(o, { name: "F1" }, db), await createFolder(o, { name: "F2" }, db), await createFolder(o, { name: "F3" }, db)];
      expect(await reorderFolders(o, [f3.id, f1.id, f2.id], db)).toEqual({ ok: true });
      expect((await getSidebar(o, db)).folders.map((f) => f.name)).toEqual(["F3", "F1", "F2"]);
      await expect(reorderFolders(o, [f3.id, f1.id], db)).rejects.toEqual(err(409)); // missing one
      await expect(reorderFolders(o, [f3.id, f1.id, f1.id], db)).rejects.toEqual(err(409)); // duplicate

      const a = await createList(o, { name: "a", folderId: f1.id }, db);
      const b = await createList(o, { name: "b", folderId: f1.id }, db);
      const c = await createList(o, { name: "c", folderId: f1.id }, db);
      const loose1 = await createList(o, { name: "loose 1" }, db);
      const loose2 = await createList(o, { name: "loose 2" }, db);
      await updateList(o, b.list.id, { archived: true }, db);
      // The active lists of that folder, new order (archived ones are not part of it).
      expect(await reorderLists(o, { folderId: f1.id, ids: [c.list.id, a.list.id] }, db)).toEqual({ ok: true });
      await expect(reorderLists(o, { folderId: f1.id, ids: [c.list.id, a.list.id, b.list.id] }, db)).rejects.toEqual(err(409));
      await expect(reorderLists(o, { folderId: f1.id, ids: [c.list.id, loose1.list.id] }, db)).rejects.toEqual(err(409));
      expect(await reorderLists(o, { folderId: null, ids: [loose2.list.id, loose1.list.id] }, db)).toEqual({ ok: true });
      const lists = (await getSidebar(o, db)).lists.map((l) => l.name);
      // Folder order first (F3 has none, then F1), then lists outside folders.
      expect(lists).toEqual(["c", "a", "loose 2", "loose 1"]);

      const g = [await createGroup(o, { name: "G1" }, db), await createGroup(o, { name: "G2" }, db)];
      expect(await reorderGroups(o, [g[1].group.id, g[0].group.id], db)).toEqual({ ok: true });
      expect((await listGroups(o, db)).map((x) => x.name)).toEqual(["G2", "G1"]);
    } finally {
      await dropOrg(db, o);
    }
  });
});

describe("sidebar and lead memberships", () => {
  it("returns All leads, folders, active lists, the archived count, groups and workflows in one call", async () => {
    const o = await makeOrg(db, `${TAG}_sidebar`);
    try {
      const people = [] as string[];
      for (let i = 0; i < 3; i++) people.push(await makeLead(db, o, { displayName: `Sidebar owner ${i}` }));
      const f1 = await createFolder(o, { name: "Expireds" }, db);
      const f2 = await createFolder(o, { name: "Off-market" }, db);
      const l1 = await createList(o, { name: "Expireds – Oct 2026", folderId: f1.id, leadIds: people }, db);
      const l2 = await createList(o, { name: "Old expireds", folderId: f2.id, leadIds: [people[0]] }, db);
      await updateList(o, l2.list.id, { archived: true }, db);
      const l3 = await createList(o, { name: "Referrals", leadIds: [people[1]] }, db);
      const hot = await createGroup(o, { name: "Hot", color: "red", leadId: people[0] }, db);
      const nurture = await createGroup(o, { name: "Nurture" }, db);
      await addGroupMembers(o, nurture.group.id, people, db);

      const s = await getSidebar(o, db);
      expect(s.allLeads.count).toBe(3);
      expect(s.allLeads.rankedAt).toBeNull(); // no DealFlow ranking in this org yet
      expect(s.folders).toEqual([
        { id: f1.id, name: "Expireds", sortOrder: expect.any(Number), listCount: 1, archivedListCount: 0 },
        { id: f2.id, name: "Off-market", sortOrder: expect.any(Number), listCount: 1, archivedListCount: 1 },
      ]);
      expect(s.lists.map((l) => [l.name, l.folderId, l.memberCount])).toEqual([
        ["Expireds – Oct 2026", f1.id, 3],
        ["Referrals", null, 1],
      ]);
      expect(s.archivedCount).toBe(1);
      expect(s.groups.map((g) => [g.name, g.color, g.memberCount])).toEqual([["Hot", "red", 1], ["Nurture", "gray", 3]]);
      expect(s.workflows).toEqual([]);

      const m = await getLeadMemberships(o, people[0], db);
      // Active lists only, in sidebar order, with their folder's name.
      expect(m.lists).toEqual([{ id: l1.list.id, name: "Expireds – Oct 2026", folderName: "Expireds" }]);
      expect(m.groupIds).toEqual([hot.group.id, nurture.group.id]);
      expect((await getLeadMemberships(o, people[1], db)).lists).toEqual([
        { id: l1.list.id, name: "Expireds – Oct 2026", folderName: "Expireds" },
        { id: l3.list.id, name: "Referrals", folderName: null },
      ]);
    } finally {
      await dropOrg(db, o);
    }
  });
});
