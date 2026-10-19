import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { PrismaClient } from "@prisma/client";
import { prismaPerf } from "./setup/pg";
import { makeOrg, dropOrg } from "./setup/b45";
import { createFolder } from "@/lib/core-data/lists/folders";
import { createList, updateList } from "@/lib/core-data/lists/lists";
import {
  DESTINATION_MISSING,
  LIST_ARCHIVED,
  checkDestination,
  createImportBatch,
  discardImportBatch,
  parseDestination,
} from "@/lib/core-data/importer/destination";

// Brief 45 PR F — where an upload's people go [brief §5.7]. A new list is
// created with the lists API's own rules and messages (PR A createList), in
// the same transaction as the import, with source 'upload:<importId>'; a name
// that is taken is refused before anything is created or stored. Against a
// real Postgres (CI's db-suite), inside throwaway organizations. Made-up data.
const TAG = `b45f_dest_${Date.now()}`;
let db: PrismaClient;
let org: string;
let other: string;

const err = (status: number, message?: string) =>
  expect.objectContaining(message === undefined ? { status } : { status, message });
const counts = async () => ({
  batches: await db.importBatch.count({ where: { organizationId: org } }),
  lists: await db.callList.count({ where: { organizationId: org } }),
});
const upload = (name = "x.csv") => ({ organizationId: org, userId: "user_test", sourceLabel: "Test upload", filename: name });

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

describe("parseDestination", () => {
  it("needs exactly one choice: an existing list, or a new list's name", () => {
    expect(parseDestination({ listId: "l_1" })).toEqual({ kind: "list", listId: "l_1" });
    expect(parseDestination({ newListName: "Expireds", newListFolderId: "" })).toEqual({ kind: "new", name: "Expireds", folderId: null });
    expect(parseDestination({ newListName: "Expireds", newListFolderId: "f_1" })).toEqual({ kind: "new", name: "Expireds", folderId: "f_1" });
    expect(() => parseDestination({})).toThrow(DESTINATION_MISSING);
    expect(() => parseDestination({ listId: "", newListName: "" })).toThrow(DESTINATION_MISSING);
    expect(() => parseDestination({ listId: "l_1", newListName: "Expireds" })).toThrow(DESTINATION_MISSING);
  });
});

describe("a new list [brief §5.7]", () => {
  it("is created with the import, named by the lists API's rules, with source upload:<importId>", async () => {
    const folder = await createFolder(org, { name: "Expireds" }, db);
    const { batchId, list } = await createImportBatch(upload(), { kind: "new", name: "  Expireds – Oct 2026  ", folderId: folder.id }, db);
    const batch = await db.importBatch.findUniqueOrThrow({ where: { id: batchId } });
    expect(batch).toMatchObject({ status: "pending", storageKey: "pending", targetListId: list.id, dealflowScoreTokenHash: null });
    expect(list).toMatchObject({ name: "Expireds – Oct 2026", created: true });
    expect(await db.callList.findUniqueOrThrow({ where: { id: list.id } })).toMatchObject({
      organizationId: org, name: "Expireds – Oct 2026", folderId: folder.id, source: `upload:${batchId}`, archivedAt: null,
    });
  });

  it("outside any folder when no folder is chosen", async () => {
    const { list } = await createImportBatch(upload(), { kind: "new", name: "Referrals", folderId: null }, db);
    expect((await db.callList.findUniqueOrThrow({ where: { id: list.id } })).folderId).toBeNull();
  });

  it("a name already taken in that place is refused with the API's message, and nothing is created", async () => {
    const before = await counts();
    await expect(createImportBatch(upload(), { kind: "new", name: "referrals", folderId: null }, db)).rejects.toEqual(
      err(409, 'A list named "Referrals" is already outside folders.'),
    );
    const folder = await db.folder.findFirstOrThrow({ where: { organizationId: org, name: "Expireds" } });
    await expect(createImportBatch(upload(), { kind: "new", name: "EXPIREDS – OCT 2026", folderId: folder.id }, db)).rejects.toEqual(
      err(409, 'A list named "Expireds – Oct 2026" is already in this folder.'),
    );
    expect(await counts()).toEqual(before);
  });

  it("an archived list's name still counts (unarchiving can never make a duplicate)", async () => {
    const { list } = await createList(org, { name: "Old expireds" }, db);
    await updateList(org, list.id, { archived: true }, db);
    await expect(createImportBatch(upload(), { kind: "new", name: "Old Expireds", folderId: null }, db)).rejects.toEqual(err(409));
  });

  it("a bad name or an unknown folder: the API's plain-English refusal, nothing created", async () => {
    const before = await counts();
    await expect(createImportBatch(upload(), { kind: "new", name: "   ", folderId: null }, db)).rejects.toEqual(err(400, "Name must be 1–60 characters."));
    await expect(createImportBatch(upload(), { kind: "new", name: "x".repeat(61), folderId: null }, db)).rejects.toEqual(err(400));
    await expect(createImportBatch(upload(), { kind: "new", name: "Nowhere", folderId: "no_such_folder" }, db)).rejects.toEqual(err(404, "Folder not found."));
    const foreignFolder = await createFolder(other, { name: "Theirs" }, db);
    await expect(createImportBatch(upload(), { kind: "new", name: "Nowhere", folderId: foreignFolder.id }, db)).rejects.toEqual(err(404, "Folder not found."));
    expect(await counts()).toEqual(before);
  });

  it("the refusal says where it belongs (the destination step)", async () => {
    await expect(createImportBatch(upload(), { kind: "new", name: "Referrals", folderId: null }, db)).rejects.toMatchObject({
      extra: { field: "destination" },
    });
  });
});

describe("an existing list", () => {
  it("is linked as it is (no new list)", async () => {
    const { list: target } = await createList(org, { name: "Brownstones" }, db);
    const before = await counts();
    const { batchId, list } = await createImportBatch(upload(), { kind: "list", listId: target.id }, db);
    expect(list).toEqual({ id: target.id, name: "Brownstones", created: false });
    expect((await db.importBatch.findUniqueOrThrow({ where: { id: batchId } })).targetListId).toBe(target.id);
    expect(await counts()).toEqual({ batches: before.batches + 1, lists: before.lists });
    expect((await db.callList.findUniqueOrThrow({ where: { id: target.id } })).source).toBe("manual");
  });

  it("an archived list, another org's list or an unknown id is refused", async () => {
    const archived = await db.callList.findFirstOrThrow({ where: { organizationId: org, name: "Old expireds" } });
    await expect(createImportBatch(upload(), { kind: "list", listId: archived.id }, db)).rejects.toEqual(err(409, LIST_ARCHIVED));
    const { list: theirs } = await createList(other, { name: "Theirs" }, db);
    await expect(createImportBatch(upload(), { kind: "list", listId: theirs.id }, db)).rejects.toEqual(err(404, "List not found."));
    await expect(createImportBatch(upload(), { kind: "list", listId: "no_such_list" }, db)).rejects.toEqual(err(404, "List not found."));
  });
});

describe("checkDestination: the same checks, before the file is sent, writing nothing", () => {
  it("accepts a free name and an active list, and creates nothing", async () => {
    const before = await counts();
    expect(await checkDestination(org, { kind: "new", name: " Fresh name ", folderId: null }, db)).toEqual({ name: "Fresh name" });
    const brownstones = await db.callList.findFirstOrThrow({ where: { organizationId: org, name: "Brownstones" } });
    expect(await checkDestination(org, { kind: "list", listId: brownstones.id }, db)).toEqual({ name: "Brownstones" });
    expect(await counts()).toEqual(before);
    expect(await db.callList.count({ where: { organizationId: org, name: "Fresh name" } })).toBe(0);
  });

  it("refuses exactly what the upload would refuse", async () => {
    await expect(checkDestination(org, { kind: "new", name: "REFERRALS", folderId: null }, db)).rejects.toEqual(
      err(409, 'A list named "Referrals" is already outside folders.'),
    );
    await expect(checkDestination(org, { kind: "new", name: "", folderId: null }, db)).rejects.toEqual(err(400, "Name must be 1–60 characters."));
    await expect(checkDestination(org, { kind: "list", listId: "no_such_list" }, db)).rejects.toEqual(err(404, "List not found."));
  });
});

describe("discardImportBatch: an upload whose file couldn't be stored leaves nothing behind", () => {
  it("removes the import and the empty list it created, so the name is free again", async () => {
    const { batchId, list } = await createImportBatch(upload(), { kind: "new", name: "Half done", folderId: null }, db);
    await discardImportBatch(org, batchId, list, db);
    expect(await db.importBatch.findUnique({ where: { id: batchId } })).toBeNull();
    expect(await db.callList.findUnique({ where: { id: list.id } })).toBeNull();
    // The name can be used again.
    const again = await createImportBatch(upload(), { kind: "new", name: "Half done", folderId: null }, db);
    expect(again.list.created).toBe(true);
  });

  it("never removes a list that existed before the upload", async () => {
    const brownstones = await db.callList.findFirstOrThrow({ where: { organizationId: org, name: "Brownstones" } });
    const { batchId, list } = await createImportBatch(upload(), { kind: "list", listId: brownstones.id }, db);
    await discardImportBatch(org, batchId, list, db);
    expect(await db.importBatch.findUnique({ where: { id: batchId } })).toBeNull();
    expect(await db.callList.findUnique({ where: { id: brownstones.id } })).not.toBeNull();
  });
});
