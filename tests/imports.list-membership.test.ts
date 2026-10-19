import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { PrismaClient } from "@prisma/client";
import { prismaPerf } from "./setup/pg";
import { makeOrg, dropOrg } from "./setup/b45";
import { putObject } from "@/lib/core-data/importer/storage";
import { commitImport } from "@/lib/core-data/importer/commit-worker";
import { claimImportCommit, type CommitClaim } from "@/lib/core-data/importer/batch";
import { createList, deleteList } from "@/lib/core-data/lists/lists";
import { addListMembers } from "@/lib/core-data/lists/memberships";
import { addImportLeadsToList } from "@/lib/core-data/importer/list-membership";
import { getImportSummary } from "@/lib/core-data/importer/summary";
import type { MappingProposal } from "@/lib/core-data/importer/ai-mapping";
import type { EmitResult } from "@/lib/core-data/events/emit";

// Brief 45 PR F — an upload fills its list [brief §5.7]: every row's lead
// becomes a ListMembership added by 'import:<id>', new leads and leads already
// in the CRM (merged) alike, idempotent on re-runs and resumes. The merge
// itself is unchanged: Ryan's Oct 16 import rule (same phone + same address +
// different name = one lead, never renamed, status kept, blanks filled) still
// holds, and the lead lands on the list. Through commitImport, against a real
// Postgres, in a throwaway organization. Made-up people only.
const TAG = `b45f_mem_${Date.now()}`;
const emit = async (): Promise<EmitResult> => ({ overflow: false, bytes: 0 });
let db: PrismaClient;
let org: string;

const col = (column: string, field: string) => ({
  column, sampleValues: [], target: { kind: "standard_field" as const, field }, confidence: 1, reasoning: "",
});
const mapping = (...cols: ReturnType<typeof col>[]): MappingProposal => ({ mapping: cols, likelyDuplicates: [] } as unknown as MappingProposal);
const FULL = mapping(col("MojoID", "Lead.mojoId"), col("Name", "Lead.name"), col("Address", "Lead.primaryAddressFull"), col("Phone", "ContactPhone.phone"), col("Status", "Lead.statusLabel"));
const PHONE_ONLY = mapping(col("Phone", "ContactPhone.phone"));
const runIdOf = (c: CommitClaim) => (c.claimed ? c.runId : undefined);

async function listFor(name: string): Promise<string> {
  return (await createList(org, { name }, db)).list.id;
}

async function batchFor(csv: string, targetListId: string | null, status = "importing"): Promise<string> {
  const b = await db.importBatch.create({
    data: { organizationId: org, userId: "user_test", sourceLabel: TAG, filename: "x.csv", storageKey: "pending", status, targetListId },
  });
  const key = `imports/${org}/${b.id}/x.csv`;
  await putObject(key, Buffer.from(csv), db);
  await db.importBatch.update({ where: { id: b.id }, data: { storageKey: key } });
  return b.id;
}

const members = (listId: string) =>
  db.listMembership.findMany({ where: { listId }, select: { leadId: true, addedBy: true }, orderBy: { leadId: "asc" } });
const leadsWithPhone = (phone: string) =>
  db.lead.findMany({ where: { organizationId: org, contacts: { some: { phones: { some: { phone } } } } }, select: { id: true } });
const leadRow = (id: string) =>
  db.lead.findUniqueOrThrow({ where: { id }, select: { displayName: true, name: true, primaryAddressFull: true, statusLabel: true, mojoId: true } });

beforeAll(async () => {
  db = prismaPerf(4);
  await db.$connect();
  org = await makeOrg(db, TAG);
});

afterAll(async () => {
  if (org) await dropOrg(db, org);
  await db?.$disconnect();
});

describe("every row's lead goes on the target list [brief §5.7]", () => {
  it("new leads and existing (merged) ones alike, added by import:<id>; Ryan's Oct 16 rule unchanged", async () => {
    // Already in the CRM: same phone and same street as row 1, another name on the file.
    const kim = await db.lead.create({
      data: {
        organizationId: org, displayName: "Kim Testowner", name: "Kim Testowner", primaryAddressFull: "8 Example St, Brooklyn, NY 11201",
        primaryAddressSummary: "8 Example St", statusLabel: "Hot", mojoId: null,
        contacts: { create: { organizationId: org, displayName: "Kim Testowner", phones: { create: { phone: "+12125550105", type: "mobile", isPrimary: true } } } },
      },
    });
    const before = await leadRow(kim.id);
    const listId = await listFor("Expireds – Oct 2026");
    const csv = [
      "MojoID,Name,Address,Phone,Status",
      `${TAG}_lee,Lee Otherperson,8 Example Street,212-555-0105,Cold`, // same phone + street, other name: Kim's lead
      `${TAG}_n1,Test Owner One,101 Sample Ave,212-555-0111,New`,
      `${TAG}_n2,Test Owner Two,102 Sample Ave,212-555-0112,New`,
    ].join("\n");
    const id = await batchFor(csv, listId);
    const res = await commitImport(id, "merge", FULL, "c", { emit, db });
    expect(res).toMatchObject({ totalRows: 3, importedRows: 3, duplicateRows: 1, errorRows: 0 });

    // Ryan's Oct 16 rule: one lead, never renamed, status kept, blanks filled (its Mojo ID).
    expect(await leadsWithPhone("+12125550105")).toEqual([{ id: kim.id }]);
    expect(await leadRow(kim.id)).toEqual({ ...before, mojoId: `${TAG}_lee` });

    const n1 = await db.lead.findFirstOrThrow({ where: { organizationId: org, mojoId: `${TAG}_n1` } });
    const n2 = await db.lead.findFirstOrThrow({ where: { organizationId: org, mojoId: `${TAG}_n2` } });
    expect(await members(listId)).toEqual(
      [kim.id, n1.id, n2.id].sort().map((leadId) => ({ leadId, addedBy: `import:${id}` })),
    );

    // The summary counts people, not rows: 2 new, 1 already in the CRM.
    expect(await getImportSummary(db, org, id)).toMatchObject({
      targetList: { id: listId, name: "Expireds – Oct 2026", folderName: null, archived: false },
      people: { new: 2, existing: 1, newWithoutMojoId: 0 },
    });
  });

  it("an upload's counts stay the same when a later upload merges the same people", async () => {
    const listA = await listFor("First upload");
    const idA = await batchFor(`MojoID,Name,Phone\n${TAG}_s1,Test Owner S1,212-555-0124\n${TAG}_s2,Test Owner S2,212-555-0125\n`, listA);
    await commitImport(idA, "merge", mapping(col("MojoID", "Lead.mojoId"), col("Name", "Lead.name"), col("Phone", "ContactPhone.phone")), "c", { emit, db });
    const before = await getImportSummary(db, org, idA);
    expect(before?.people).toEqual({ new: 2, existing: 0, newWithoutMojoId: 0 });
    // A second upload merges one of them (and re-stamps its source).
    const idB = await batchFor(`MojoID,Name\n${TAG}_s1,Test Owner S1\n`, await listFor("Second upload"));
    await commitImport(idB, "merge", mapping(col("MojoID", "Lead.mojoId"), col("Name", "Lead.name")), "c", { emit, db });
    expect(await db.lead.count({ where: { organizationId: org, source: `import:${idA}` } })).toBe(1);
    expect(await getImportSummary(db, org, idA)).toEqual(before);
    expect((await getImportSummary(db, org, idB))?.people).toEqual({ new: 0, existing: 1, newWithoutMojoId: 0 });
  });

  it("a completed import run again changes nothing (no duplicate memberships)", async () => {
    const listId = await listFor("Run twice");
    const id = await batchFor("Phone\n212-555-0121\n212-555-0122\n", listId);
    await commitImport(id, "merge", PHONE_ONLY, "c", { emit, db });
    const first = await members(listId);
    expect(first).toHaveLength(2);
    await commitImport(id, "merge", PHONE_ONLY, "c", { emit, db });
    expect(await members(listId)).toEqual(first);
  });

  it("rows that are the same person make one membership", async () => {
    const listId = await listFor("Same person twice");
    const id = await batchFor("Phone\n212-555-0131\n212-555-0131\n212-555-0131\n", listId);
    expect(await commitImport(id, "merge", PHONE_ONLY, "c", { emit, db })).toMatchObject({ importedRows: 3, duplicateRows: 2 });
    expect(await members(listId)).toHaveLength(1);
  });

  it("someone already on the list keeps their place (and how they were added)", async () => {
    const listId = await listFor("Already there");
    const id1 = await batchFor("Phone\n212-555-0141\n", null);
    await commitImport(id1, "merge", PHONE_ONLY, "c", { emit, db });
    const [lead] = await leadsWithPhone("+12125550141");
    await addListMembers(org, listId, [lead.id], { addedBy: "manual" }, db);
    const id2 = await batchFor("Phone\n212-555-0141\n212-555-0142\n", listId);
    await commitImport(id2, "merge", PHONE_ONLY, "c", { emit, db });
    const [other] = await leadsWithPhone("+12125550142");
    expect(await members(listId)).toEqual(
      [{ leadId: lead.id, addedBy: "manual" }, { leadId: other.id, addedBy: `import:${id2}` }].sort((a, b) => (a.leadId < b.leadId ? -1 : 1)),
    );
  });

  it("an import that runs out of time and is run again ends with every row's lead on the list, once", async () => {
    const listId = await listFor("Resumed");
    const phones = Array.from({ length: 6 }, (_, k) => `212-555-016${k}`);
    const id = await batchFor(`Phone\n${phones.join("\n")}\n`, listId);
    let t = 0;
    await expect(commitImport(id, "merge", PHONE_ONLY, "c", { emit, db, now: () => (t += 1000), timeLimitMs: 2_500 })).rejects.toThrow(/time limit/);
    const claim = await claimImportCommit(db, id, org, PHONE_ONLY);
    expect(claim).toMatchObject({ claimed: true });
    await commitImport(id, "merge", PHONE_ONLY, "c", { emit, db, runId: runIdOf(claim) });
    const leadIds = (await Promise.all(phones.map((p) => leadsWithPhone(`+1${p.replace(/-/g, "")}`)))).map((ls) => {
      expect(ls).toHaveLength(1);
      return ls[0].id;
    });
    expect((await members(listId)).map((m) => m.leadId)).toEqual([...leadIds].sort());
  });

  it("an upload aimed at no list (made before lists existed) imports as before and adds no membership", async () => {
    const before = await db.listMembership.count({ where: { list: { organizationId: org } } });
    const id = await batchFor("Phone\n212-555-0171\n", null);
    expect(await commitImport(id, "merge", PHONE_ONLY, "c", { emit, db })).toMatchObject({ importedRows: 1 });
    expect(await db.listMembership.count({ where: { list: { organizationId: org } } })).toBe(before);
  });

  it("a list deleted before the upload finishes: the import still completes, its people stay in the CRM", async () => {
    const listId = await listFor("Deleted meanwhile");
    const id = await batchFor("Phone\n212-555-0181\n", listId);
    await deleteList(org, listId, db); // targetListId → NULL (ON DELETE SET NULL)
    expect(await commitImport(id, "merge", PHONE_ONLY, "c", { emit, db })).toMatchObject({ importedRows: 1 });
    expect((await db.importBatch.findUniqueOrThrow({ where: { id } })).status).toBe("completed");
    expect(await leadsWithPhone("+12125550181")).toHaveLength(1);
  });
});

describe("addImportLeadsToList", () => {
  it("adds the given leads and, at the end, every lead the import stamped; never another org's lead", async () => {
    const listId = await listFor("Direct");
    const id = await batchFor("Phone\n212-555-0191\n", null);
    await commitImport(id, "merge", PHONE_ONLY, "c", { emit, db });
    const [stamped] = await leadsWithPhone("+12125550191");
    const otherOrg = await makeOrg(db, `${TAG}_x`);
    try {
      const foreign = await db.lead.create({ data: { organizationId: otherOrg, displayName: "Test Owner Elsewhere" } });
      expect(await addImportLeadsToList(db, org, listId, id, [foreign.id])).toEqual({ added: 0, listGone: false });
      expect(await addImportLeadsToList(db, org, listId, id, [], { everyImportedLead: true })).toEqual({ added: 1, listGone: false });
      expect(await members(listId)).toEqual([{ leadId: stamped.id, addedBy: `import:${id}` }]);
      expect(await addImportLeadsToList(db, org, "no_such_list", id, [stamped.id])).toEqual({ added: 0, listGone: true });
    } finally {
      await dropOrg(db, otherOrg);
    }
  });
});
