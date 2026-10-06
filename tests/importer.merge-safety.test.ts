import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { PrismaClient } from "@prisma/client";
import { prismaPerf } from "./setup/pg";
import { putObject } from "@/lib/core-data/importer/storage";
import { commitImport } from "@/lib/core-data/importer/commit-worker";
import { claimImportCommit, getImportStatus } from "@/lib/core-data/importer/batch";
import type { MappingProposal } from "@/lib/core-data/importer/ai-mapping";
import type { EmitResult } from "@/lib/core-data/events/emit";

// Brief 41 (H4, M25): import safety, against the perf DB inside a throwaway
// organization. A merge import used to overwrite a matched lead's name,
// address, status and Mojo ID with blanks whenever the file lacked those
// columns; a row with a different Mojo ID could take over another property's
// lead by phone; rows sharing a phone raced into duplicate leads; a failed
// commit stayed "importing" forever; and the status read returned the raw file.
const TAG = `b41_imp_${Date.now()}`;
const emit = async (): Promise<EmitResult> => ({ overflow: false, bytes: 0 });
let db: PrismaClient;
let org: string;
let userId: string;
const lead: Record<"alice" | "bob" | "carol", string> = { alice: "", bob: "", carol: "" };

const col = (column: string, field: string) => ({
  column, sampleValues: [], target: { kind: "standard_field" as const, field }, confidence: 1, reasoning: "",
});
const mapping = (...cols: ReturnType<typeof col>[]): MappingProposal => ({ mapping: cols, likelyDuplicates: [] } as unknown as MappingProposal);
const PHONE_ONLY = mapping(col("Phone", "ContactPhone.phone"));
const MOJO_NAME = mapping(col("MojoID", "Lead.mojoId"), col("Name", "Lead.name"));
const MOJO_NAME_PHONE = mapping(col("MojoID", "Lead.mojoId"), col("Name", "Lead.name"), col("Phone", "ContactPhone.phone"));
const MOJO_PHONE = mapping(col("MojoID", "Lead.mojoId"), col("Phone", "ContactPhone.phone"));

async function batchFor(csv: string, status = "importing"): Promise<string> {
  const b = await db.importBatch.create({
    data: { organizationId: org, userId, sourceLabel: TAG, filename: "x.csv", storageKey: "pending", status },
  });
  const key = `imports/${org}/${b.id}/x.csv`;
  await putObject(key, Buffer.from(csv), db);
  await db.importBatch.update({ where: { id: b.id }, data: { storageKey: key } });
  return b.id;
}

async function seedLead(key: keyof typeof lead, data: { name: string; address: string; status: string; mojoId: string | null; phone: string }) {
  const l = await db.lead.create({
    data: {
      organizationId: org,
      displayName: data.name,
      name: data.name,
      primaryAddressFull: data.address,
      primaryAddressSummary: data.address.split(",")[0],
      statusLabel: data.status,
      mojoId: data.mojoId,
      contacts: {
        create: { organizationId: org, displayName: data.name, phones: { create: { phone: data.phone, type: "mobile", isPrimary: true } } },
      },
    },
  });
  lead[key] = l.id;
}

const leadRow = (id: string) =>
  db.lead.findUniqueOrThrow({
    where: { id },
    select: { displayName: true, name: true, primaryAddressFull: true, primaryAddressSummary: true, statusLabel: true, mojoId: true },
  });
const leadsWithPhone = (phone: string) =>
  db.lead.findMany({ where: { organizationId: org, contacts: { some: { phones: { some: { phone } } } } }, select: { id: true, mojoId: true } });

beforeAll(async () => {
  db = prismaPerf(4);
  await db.$connect();
  org = (await db.organization.create({ data: { slug: TAG, name: "Brief 41 import test" } })).id;
  userId = (await db.user.create({ data: { organizationId: org, email: `${TAG}@example.com`, displayName: "Importer" } })).id;
  await seedLead("alice", { name: "Alice Owner", address: "10 Main St, Brooklyn, NY 11201", status: "Hot", mojoId: `${TAG}_m1`, phone: "+12125550101" });
  await seedLead("bob", { name: "Bob Owner", address: "20 Oak St, Brooklyn, NY 11215", status: "Warm", mojoId: `${TAG}_m2`, phone: "+12125550102" });
  await seedLead("carol", { name: "Carol Owner", address: "30 Elm St, Brooklyn, NY 11217", status: "New", mojoId: null, phone: "+12125550103" });
}, 120_000);

afterAll(async () => {
  if (org) {
    await db.customFieldValue.deleteMany({ where: { organizationId: org } });
    await db.lead.deleteMany({ where: { organizationId: org } });
    await db.customFieldDefinition.deleteMany({ where: { organizationId: org } });
    await db.importBatch.deleteMany({ where: { organizationId: org } });
    await db.user.deleteMany({ where: { organizationId: org } });
    await db.organization.delete({ where: { id: org } });
  }
  await db?.$disconnect();
});

describe("merge import keeps what the file doesn't contain (Brief 41, H4)", () => {
  it("a phone-only file leaves names, addresses, statuses and Mojo IDs unchanged", async () => {
    const before = { alice: await leadRow(lead.alice), bob: await leadRow(lead.bob) };
    const res = await commitImport(await batchFor("Phone\n212-555-0101\n(212) 555-0102\n"), "merge", PHONE_ONLY, "c", { emit, db });
    expect(res).toMatchObject({ totalRows: 2, importedRows: 2, duplicateRows: 2, errorRows: 0 });
    expect(await leadRow(lead.alice)).toEqual(before.alice);
    expect(await leadRow(lead.bob)).toEqual(before.bob);
  });

  it("a file with a name but no address updates the name only", async () => {
    const before = await leadRow(lead.alice);
    await commitImport(await batchFor(`MojoID,Name\n${TAG}_m1,Alice Q Owner\n`), "merge", MOJO_NAME, "c", { emit, db });
    expect(await leadRow(lead.alice)).toEqual({ ...before, name: "Alice Q Owner", displayName: "Alice Q Owner" });
  });

  it("a matched lead with no Mojo ID gets the file's Mojo ID; nothing else is blanked", async () => {
    const before = await leadRow(lead.carol);
    await commitImport(await batchFor(`MojoID,Phone\n${TAG}_m3,212-555-0103\n`), "merge", MOJO_PHONE, "c", { emit, db });
    expect(await leadRow(lead.carol)).toEqual({ ...before, mojoId: `${TAG}_m3` });
  });

  it("a different Mojo ID on the same phone is another property: a new lead, the old one untouched", async () => {
    const before = await leadRow(lead.bob);
    const res = await commitImport(await batchFor(`MojoID,Name,Phone\n${TAG}_m9,Bob Owner,212-555-0102\n`), "merge", MOJO_NAME_PHONE, "c", { emit, db });
    expect(res).toMatchObject({ importedRows: 1, duplicateRows: 0 });
    expect(await leadRow(lead.bob)).toEqual(before);
    const both = await leadsWithPhone("+12125550102");
    expect(both.map((l) => l.mojoId).sort()).toEqual([`${TAG}_m2`, `${TAG}_m9`]);
  });
});

describe("rows that share an identity are imported one after another (Brief 41, M25a)", () => {
  it("30 rows with the same new phone make one lead", async () => {
    const rows = Array.from({ length: 30 }, () => "212-555-0199").join("\n");
    const res = await commitImport(await batchFor(`Phone\n${rows}\n`), "merge", PHONE_ONLY, "c", { emit, db });
    expect(res).toMatchObject({ totalRows: 30, importedRows: 30, duplicateRows: 29, errorRows: 0 });
    expect(await leadsWithPhone("+12125550199")).toHaveLength(1);
  });

  it("a Mojo row and a phone-only row for the same owner make one lead", async () => {
    const csv = `MojoID,Name,Phone\n${TAG}_m20,Dana Owner,212-555-0120\n,Dana Owner,212-555-0120\n${TAG}_m20,Dana Owner,\n`;
    const res = await commitImport(await batchFor(csv), "merge", MOJO_NAME_PHONE, "c", { emit, db });
    expect(res).toMatchObject({ totalRows: 3, importedRows: 3, duplicateRows: 2, errorRows: 0 });
    const leads = await leadsWithPhone("+12125550120");
    expect(leads).toHaveLength(1);
    expect(leads[0].mojoId).toBe(`${TAG}_m20`);
  });
});

describe("the commit is claimed once, marked on failure, and never re-run (Brief 41, M25b)", () => {
  it("only one claim wins, and an importing or completed batch can't be claimed again", async () => {
    const id = await batchFor("Phone\n212-555-0130\n", "mapping_review");
    const first = await claimImportCommit(db, id, org, PHONE_ONLY);
    const second = await claimImportCommit(db, id, org, PHONE_ONLY);
    expect(first).toEqual({ claimed: true });
    expect(second).toEqual({ claimed: false, status: "importing" });
    await commitImport(id, "merge", PHONE_ONLY, "c", { emit, db });
    expect(await claimImportCommit(db, id, org, PHONE_ONLY)).toEqual({ claimed: false, status: "completed" });
    expect(await claimImportCommit(db, "ib_missing", org, PHONE_ONLY)).toEqual({ claimed: false, status: null });
  });

  it("a commit that fails is marked failed with the reason, and can then be claimed again", async () => {
    const b = await db.importBatch.create({
      data: { organizationId: org, userId, sourceLabel: TAG, filename: "x.csv", storageKey: `imports/${org}/nope/x.csv`, status: "importing" },
    });
    await expect(commitImport(b.id, "merge", PHONE_ONLY, "c", { emit, db })).rejects.toThrow(/no stored bytes/);
    const after = await db.importBatch.findUniqueOrThrow({ where: { id: b.id } });
    expect(after.status).toBe("failed");
    expect(JSON.stringify(after.errorLog)).toMatch(/no stored bytes/);
    expect(await claimImportCommit(db, b.id, org, PHONE_ONLY)).toEqual({ claimed: true });
  });

  it("re-running a completed batch changes nothing", async () => {
    const id = await batchFor("Phone\n212-555-0140\n");
    const first = await commitImport(id, "merge", PHONE_ONLY, "c", { emit, db });
    const again = await commitImport(id, "merge", PHONE_ONLY, "c", { emit, db });
    expect(again).toEqual(first);
    expect(await leadsWithPhone("+12125550140")).toHaveLength(1);
  });
});

describe("the status read never returns the raw file (Brief 41, M25c)", () => {
  it("has the counts and progress but no sourceBlob or mapping", async () => {
    const id = await batchFor("Phone\n212-555-0150\n");
    await commitImport(id, "merge", PHONE_ONLY, "c", { emit, db });
    const status = await getImportStatus(db, id, org);
    expect(status).toMatchObject({ id, status: "completed", totalRows: 1, importedRows: 1, progress: 100 });
    expect(status).not.toHaveProperty("sourceBlob");
    expect(status).not.toHaveProperty("mappingJson");
    expect(JSON.stringify(status).length).toBeLessThan(2_000);
    expect(await getImportStatus(db, id, "org_other")).toBeNull();
  });
});
