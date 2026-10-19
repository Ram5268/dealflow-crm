import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { PrismaClient } from "@prisma/client";
import { perfConnectionString, prismaPerf } from "./setup/pg";
import { makeOrg, dropOrg, makeLead } from "./setup/b45";

// Brief 50 PR 7 (open item 6.12): scripts/restore-from-backup.ts puts back
// Ryan's folders, lists and groups (and who is on each), which
// scripts/backup.ts already saves. In order (folders → lists → groups →
// memberships), safe to run twice, and organization by organization: a row
// never lands in, or overwrites, another organization's folders, lists or
// groups, and nobody joins a list or group of another organization. The
// script keeps its guard: a database that isn't a test database needs
// --i-mean-live.
//
// The real script runs here (tsx, a child process) against the test
// database, on a made-up backup in backup.ts's shape. Real Postgres (CI's
// db-suite), throwaway organizations, made-up people.
const TAG = `b50p7_restore_${Date.now()}`;
const T = (iso: string) => new Date(iso);
let db: PrismaClient;
let o: string;
let p: string;
let dir: string;
const L: string[] = [];
let theirLead: string;
const P: Record<"folder" | "list" | "group", string> = { folder: "", list: "", group: "" };

function restore(file: string, url = perfConnectionString()) {
  const r = spawnSync("node_modules/.bin/tsx", ["scripts/restore-from-backup.ts", file], {
    env: { PATH: process.env.PATH, HOME: process.env.HOME, TMPDIR: process.env.TMPDIR, DATABASE_URL_MAIN: url },
    encoding: "utf8",
    timeout: 90_000,
  });
  return { status: r.status, out: `${r.stdout}\n${r.stderr}` };
}

// What backup.ts writes, for one organization's rows only (JSON, so every date is a string).
async function backupOf(orgId: string) {
  const inOrg = { where: { organizationId: orgId } };
  const data = {
    stamp: TAG,
    organizations: await db.organization.findMany({ where: { id: orgId } }),
    users: await db.user.findMany(inOrg),
    leads: await db.lead.findMany(inOrg),
    contacts: [],
    contactPhones: [],
    contactEmails: [],
    customFieldDefinitions: [],
    customFieldValues: [],
    savedViews: [],
    dealFlowDerivedSignals: [],
    folders: await db.folder.findMany(inOrg),
    callLists: await db.callList.findMany(inOrg),
    listMemberships: await db.listMembership.findMany({ where: { list: { organizationId: orgId } } }),
    leadGroups: await db.leadGroup.findMany(inOrg),
    leadGroupMemberships: await db.leadGroupMembership.findMany({ where: { group: { organizationId: orgId } } }),
  };
  return JSON.parse(JSON.stringify(data)) as Record<string, Record<string, unknown>[]> & { stamp: string };
}

function write(name: string, data: unknown): string {
  const file = path.join(dir, name);
  writeFileSync(file, JSON.stringify(data, null, 2));
  return file;
}

async function snapshot(orgId: string) {
  const inOrg = { where: { organizationId: orgId }, orderBy: { id: "asc" as const } };
  return {
    folders: await db.folder.findMany(inOrg),
    lists: await db.callList.findMany(inOrg),
    groups: await db.leadGroup.findMany(inOrg),
    listMembers: await db.listMembership.findMany({ where: { list: { organizationId: orgId } }, orderBy: [{ listId: "asc" }, { leadId: "asc" }] }),
    groupMembers: await db.leadGroupMembership.findMany({ where: { group: { organizationId: orgId } }, orderBy: [{ groupId: "asc" }, { leadId: "asc" }] }),
  };
}

async function wipe(orgId: string) {
  await db.listMembership.deleteMany({ where: { list: { organizationId: orgId } } });
  await db.leadGroupMembership.deleteMany({ where: { group: { organizationId: orgId } } });
  await db.callList.deleteMany({ where: { organizationId: orgId } });
  await db.folder.deleteMany({ where: { organizationId: orgId } });
  await db.leadGroup.deleteMany({ where: { organizationId: orgId } });
}

beforeAll(async () => {
  db = prismaPerf(2);
  await db.$connect();
  dir = mkdtempSync(path.join(os.tmpdir(), "b50p7-restore-"));
  o = await makeOrg(db, TAG);
  p = await makeOrg(db, `${TAG}_other`);
  for (let i = 0; i < 4; i++) L.push(await makeLead(db, o, { displayName: `Test Owner ${i}`, address: `${100 + i} Example St` }));
  theirLead = await makeLead(db, p, { displayName: "Test Owner theirs" });

  const at = { createdAt: T("2026-10-18T14:00:00Z"), updatedAt: T("2026-10-18T15:30:00.123Z") };
  const f1 = await db.folder.create({ data: { organizationId: o, name: "Expireds", sortOrder: 0, ...at } });
  const f2 = await db.folder.create({ data: { organizationId: o, name: "Off-market", sortOrder: 1, ...at } });
  const a = await db.callList.create({ data: { organizationId: o, name: "Expireds – Oct 2026", folderId: f1.id, source: "upload:imp_test", sortOrder: 0, ...at } });
  const b = await db.callList.create({ data: { organizationId: o, name: "Referrals", sortOrder: 2, ...at } });
  const c = await db.callList.create({ data: { organizationId: o, name: "Brownstones", folderId: f2.id, sortOrder: 0, archivedAt: T("2026-10-19T12:00:00Z"), ...at } });
  const hot = await db.leadGroup.create({ data: { organizationId: o, name: "Hot", color: "red", sortOrder: 0, ...at } });
  const nurture = await db.leadGroup.create({ data: { organizationId: o, name: "Nurture", color: "blue", sortOrder: 1, ...at } });
  await db.listMembership.createMany({
    data: [
      { listId: a.id, leadId: L[0], addedBy: "import:imp_test", addedAt: T("2026-10-18T14:01:00Z") },
      { listId: a.id, leadId: L[1], addedBy: "import:imp_test", addedAt: T("2026-10-18T14:01:00Z") },
      { listId: b.id, leadId: L[2], addedBy: "manual", addedAt: T("2026-10-18T16:00:00Z") },
      { listId: c.id, leadId: L[3], addedBy: "bulk", addedAt: T("2026-10-18T17:00:00Z") },
    ],
  });
  await db.leadGroupMembership.createMany({
    data: [
      { groupId: hot.id, leadId: L[0], addedBy: "pipeline", addedAt: T("2026-10-18T18:00:00Z") },
      { groupId: hot.id, leadId: L[3], addedBy: "manual", addedAt: T("2026-10-18T18:05:00Z") },
      { groupId: nurture.id, leadId: L[1], addedBy: "bulk", addedAt: T("2026-10-18T18:10:00Z") },
    ],
  });

  // Another organization's folder, list and group, with someone on each.
  P.folder = (await db.folder.create({ data: { organizationId: p, name: "Their folder" } })).id;
  P.list = (await db.callList.create({ data: { organizationId: p, name: "Their list", folderId: P.folder } })).id;
  P.group = (await db.leadGroup.create({ data: { organizationId: p, name: "Their group" } })).id;
  await db.listMembership.create({ data: { listId: P.list, leadId: theirLead, addedBy: "manual" } });
  await db.leadGroupMembership.create({ data: { groupId: P.group, leadId: theirLead, addedBy: "manual" } });
});

afterAll(async () => {
  if (dir) rmSync(dir, { recursive: true, force: true });
  if (o) await dropOrg(db, o);
  if (p) await dropOrg(db, p);
  await db?.$disconnect();
});

describe("restore-from-backup.ts puts folders, lists and groups back", () => {
  it("back up → wipe → restore → identical, and a second run changes nothing", async () => {
    const file = write("roundtrip.json", await backupOf(o));
    const before = await snapshot(o);
    const theirs = await snapshot(p);
    expect(before.folders).toHaveLength(2);
    expect(before.listMembers).toHaveLength(4);

    await wipe(o);
    expect((await snapshot(o)).lists).toEqual([]);

    const first = restore(file);
    expect(first.status, first.out).toBe(0);
    expect(first.out).toMatch(/2 folders, 3 lists, 2 groups, 4 list memberships, 3 group memberships/);
    expect(await snapshot(o)).toEqual(before);
    expect(await snapshot(p)).toEqual(theirs);

    const again = restore(file);
    expect(again.status, again.out).toBe(0);
    expect(await snapshot(o)).toEqual(before);
    expect(await snapshot(p)).toEqual(theirs);
  });

  it("never deletes: someone added after the backup stays on their list", async () => {
    const file = write("keeps.json", await backupOf(o));
    const list = (await db.callList.findFirstOrThrow({ where: { organizationId: o, name: "Referrals" } })).id;
    await db.listMembership.create({ data: { listId: list, leadId: L[0], addedBy: "manual" } });
    expect(restore(file).status).toBe(0);
    expect(await db.listMembership.count({ where: { listId: list } })).toBe(2);
    await db.listMembership.delete({ where: { listId_leadId: { listId: list, leadId: L[0] } } });
  });

  it("organization by organization: another organization's rows are never overwritten or joined", async () => {
    const data = await backupOf(o);
    const theirs = await snapshot(p);
    const mine = await snapshot(o);
    const list = mine.lists[0];
    // A backup that (wrongly) reuses the other organization's ids, files a list
    // under their folder, and puts people across the two organizations.
    data.folders.push({ id: P.folder, organizationId: o, name: "Taken over", sortOrder: 9, createdAt: "2026-10-18T14:00:00.000Z", updatedAt: "2026-10-18T14:00:00.000Z" });
    data.leadGroups.push({ id: P.group, organizationId: o, name: "Taken over", color: "red", sortOrder: 9, createdAt: "2026-10-18T14:00:00.000Z", updatedAt: "2026-10-18T14:00:00.000Z" });
    data.callLists.push({ id: P.list, organizationId: o, name: "Taken over", folderId: null, source: "manual", sortOrder: 9, archivedAt: null, createdAt: "2026-10-18T14:00:00.000Z", updatedAt: "2026-10-18T14:00:00.000Z" });
    data.callLists.push({ id: `${TAG}_filed_elsewhere`, organizationId: o, name: "Filed under their folder", folderId: P.folder, source: "manual", sortOrder: 5, archivedAt: null, createdAt: "2026-10-18T14:00:00.000Z", updatedAt: "2026-10-18T14:00:00.000Z" });
    data.listMemberships.push({ listId: list.id, leadId: theirLead, addedBy: "manual", addedAt: "2026-10-18T14:00:00.000Z" });
    data.listMemberships.push({ listId: P.list, leadId: L[2], addedBy: "manual", addedAt: "2026-10-18T14:00:00.000Z" });
    data.leadGroupMemberships.push({ groupId: P.group, leadId: L[2], addedBy: "manual", addedAt: "2026-10-18T14:00:00.000Z" });
    const file = write("other-org.json", data);

    const r = restore(file);
    expect(r.status, r.out).toBe(0);
    expect(r.out).toMatch(/skipped/i);
    expect(await snapshot(p)).toEqual(theirs);
    const after = await snapshot(o);
    // The list is restored, but outside the other organization's folder.
    expect(after.lists.find((l) => l.id === `${TAG}_filed_elsewhere`)).toMatchObject({ organizationId: o, folderId: null });
    expect(after.listMembers).toEqual(mine.listMembers);
    expect(after.groupMembers).toEqual(mine.groupMembers);
    expect(after.folders).toEqual(mine.folders);
    expect(after.groups).toEqual(mine.groups);
    await db.callList.delete({ where: { id: `${TAG}_filed_elsewhere` } });
  });

  it("keeps its guard: a database that isn't a test database is refused, and nothing is read", () => {
    const r = restore(path.join(dir, "roundtrip.json"), "postgresql://nobody:x@127.0.0.1:9/dealflow_crm");
    expect(r.status).not.toBe(0);
    expect(r.out).toMatch(/REFUSING: restore-from-backup \(DATABASE_URL_MAIN\) would use database "dealflow_crm"/);
    expect(r.out).not.toMatch(/restore complete/);
  });
});
