import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { PrismaClient } from "@prisma/client";
import { prismaPerf } from "./setup/pg";
import { putObject } from "@/lib/core-data/importer/storage";
import { parseFile } from "@/lib/core-data/importer/parser";
import { commitImport } from "@/lib/core-data/importer/commit-worker";
import { previewDuplicates } from "@/lib/core-data/importer/duplicate-preview";
import { pickPrimaryContact } from "@/lib/core-data/smart-view/queue-service";
import type { MappingProposal } from "@/lib/core-data/importer/ai-mapping";
import type { EmitResult } from "@/lib/core-data/events/emit";

// Brief 50 PR 6, on Postgres inside a throwaway organization. Made-up people,
// fictional streets and 555-01xx numbers only.
//  - 6.7: a co-owner row's phones go to the main owner's contact, which is the
//    lead's primary contact for every reader (the Queue's pick, the list
//    pages' SQL, and the order DealFlow's copy of CRM leads reads: the first
//    contact by createdAt, then id).
//  - 6.6: the "already in your CRM" preview finds exactly the rows the commit
//    then merges, and writes nothing.
const TAG = `b50_pr6_${Date.now()}`;
const emit = async (): Promise<EmitResult> => ({ overflow: false, bytes: 0 });
let db: PrismaClient;
let org: string;
let userId: string;

const col = (column: string, field: string) => ({
  column, sampleValues: [], target: { kind: "standard_field" as const, field }, confidence: 1, reasoning: "",
});
const mapping = (...cols: ReturnType<typeof col>[]): MappingProposal => ({ mapping: cols, likelyDuplicates: [] } as unknown as MappingProposal);
const MOJO = mapping(
  col("Contact ID", "Lead.mojoId"), col("Full Name", "Lead.name"), col("Second Name", "Contact.name"),
  col("Address", "Lead.primaryAddressFull"), col("Phone 1", "ContactPhone.phone"), col("Phone 2", "ContactPhone.phone"),
);
const HEADER = "Contact ID,Full Name,Second Name,Address,Phone 1,Phone 2\n";

async function batchFor(csv: string): Promise<string> {
  const b = await db.importBatch.create({
    data: { organizationId: org, userId, sourceLabel: TAG, filename: "x.csv", storageKey: "pending", status: "mapping_review" },
  });
  const key = `imports/${org}/${b.id}/x.csv`;
  await putObject(key, Buffer.from(csv), db);
  await db.importBatch.update({ where: { id: b.id }, data: { storageKey: key } });
  return b.id;
}

const contactsOf = (leadId: string) =>
  db.contact.findMany({ where: { leadId }, include: { phones: { orderBy: { phone: "asc" } } } });

beforeAll(async () => {
  db = prismaPerf(4);
  await db.$connect();
  org = (await db.organization.create({ data: { slug: TAG, name: "Brief 50 PR 6 import test" } })).id;
  userId = (await db.user.create({ data: { organizationId: org, email: `${TAG}@example.com`, displayName: "Importer" } })).id;
}, 120_000);

afterAll(async () => {
  if (org) {
    await db.lead.deleteMany({ where: { organizationId: org } });
    await db.importBatch.deleteMany({ where: { organizationId: org } });
    await db.user.deleteMany({ where: { organizationId: org } });
    await db.organization.delete({ where: { id: org } });
  }
  await db?.$disconnect();
});

describe("a co-owner row's phones go to the main owner (6.7)", () => {
  it("the owner's contact is the primary one and holds every phone; the co-owner's holds none", async () => {
    const csv = HEADER + `${TAG}_c1,Test Owner One,Test Partner One,"100 Example St, Brooklyn, NY",212-555-0181,212-555-0182\n`;
    expect(await commitImport(await batchFor(csv), "merge", MOJO, "c", { emit, db })).toMatchObject({ importedRows: 1 });
    const lead = await db.lead.findFirstOrThrow({ where: { organizationId: org, mojoId: `${TAG}_c1` } });
    expect(lead).toMatchObject({ name: "Test Owner One", displayName: "Test Owner One" });

    const contacts = await contactsOf(lead.id);
    expect(contacts).toHaveLength(2);
    const owner = contacts.find((c) => c.name === "Test Owner One")!;
    const partner = contacts.find((c) => c.name === "Test Partner One")!;
    expect(owner.phones.map((p) => p.phone)).toEqual(["+12125550181", "+12125550182"]);
    expect(owner.phones.find((p) => p.isPrimary)?.phone).toBe("+12125550181");
    expect(partner.phones).toEqual([]);
    expect(partner.createdAt.getTime()).toBeGreaterThan(owner.createdAt.getTime());

    // Every reader picks the owner: the Queue (pickPrimaryContact), the list
    // pages (ORDER BY createdAt, id COLLATE "C") and DealFlow's copy of CRM
    // leads (ORDER BY "createdAt", id LIMIT 1).
    expect(pickPrimaryContact(contacts)?.id).toBe(owner.id);
    const [byListSql] = await db.$queryRaw<Array<{ id: string }>>`
      SELECT c.id FROM "Contact" c WHERE c."leadId" = ${lead.id} ORDER BY c."createdAt", c.id COLLATE "C" LIMIT 1`;
    const [byDealFlowSql] = await db.$queryRaw<Array<{ id: string }>>`
      SELECT id FROM "Contact" WHERE "leadId" = ${lead.id} ORDER BY "createdAt", id LIMIT 1`;
    expect(byListSql.id).toBe(owner.id);
    expect(byDealFlowSql.id).toBe(owner.id);
  });

  it("re-importing the row adds a new phone to the owner's contact; no extra contacts", async () => {
    const csv = HEADER + `${TAG}_c1,Test Owner One,Test Partner One,"100 Example St, Brooklyn, NY",212-555-0181,212-555-0183\n`;
    expect(await commitImport(await batchFor(csv), "merge", MOJO, "c", { emit, db })).toMatchObject({ duplicateRows: 1 });
    const lead = await db.lead.findFirstOrThrow({ where: { organizationId: org, mojoId: `${TAG}_c1` } });
    const contacts = await contactsOf(lead.id);
    expect(contacts).toHaveLength(2);
    expect(contacts.find((c) => c.name === "Test Owner One")!.phones.map((p) => p.phone)).toEqual(["+12125550181", "+12125550182", "+12125550183"]);
    expect(contacts.find((c) => c.name === "Test Partner One")!.phones).toEqual([]);
  });

  it("a row with no co-owner still makes one contact, as before", async () => {
    const csv = HEADER + `${TAG}_c2,Test Owner Two,,"102 Example St, Brooklyn, NY",212-555-0184,\n`;
    await commitImport(await batchFor(csv), "merge", MOJO, "c", { emit, db });
    const lead = await db.lead.findFirstOrThrow({ where: { organizationId: org, mojoId: `${TAG}_c2` } });
    const contacts = await contactsOf(lead.id);
    expect(contacts.map((c) => ({ displayName: c.displayName, phones: c.phones.map((p) => p.phone) }))).toEqual([
      { displayName: "Test Owner Two", phones: ["+12125550184"] },
    ]);
  });
});

describe('"already in your CRM" before the commit (6.6)', () => {
  const PREVIEW = mapping(col("Contact ID", "Lead.mojoId"), col("Name", "Lead.name"), col("Address", "Lead.primaryAddressFull"), col("Phone", "ContactPhone.phone"));
  const csv = [
    "Contact ID,Name,Address,Phone,Notes",
    `${TAG}_p1,Test Owner Three,"110 Example St, Brooklyn, NY",,same Mojo ID`,
    `,Test Owner Four,"111 Example St, Brooklyn, NY",212-555-0187,same phone and street`,
    `,Test Owner Five,"112 Example St, Brooklyn, NY",,same name and address`,
    `${TAG}_p9,Test Owner Six,"113 Example St, Brooklyn, NY",212-555-0189,new`,
    `,,,,nothing to match on`,
  ].join("\n") + "\n";

  beforeAll(async () => {
    await db.lead.create({ data: { organizationId: org, displayName: "Test Owner Three", name: "Test Owner Three", mojoId: `${TAG}_p1`, primaryAddressFull: "110 Example St, Brooklyn, NY" } });
    await db.lead.create({
      data: {
        organizationId: org, displayName: "Test Owner Four", name: "Test Owner Four", primaryAddressFull: "111 Example St, Brooklyn, NY",
        contacts: { create: { organizationId: org, displayName: "Test Owner Four", phones: { create: { phone: "+12125550187", type: "mobile", isPrimary: true } } } },
      },
    });
    await db.lead.create({ data: { organizationId: org, displayName: "Test Owner Five", name: "Test Owner Five", primaryAddressFull: "112 Example St, Brooklyn, NY" } });
  });

  it("lists the rows that match, how they match, with only the last 4 digits of a phone", async () => {
    const parsed = parseFile(Buffer.from(csv), "x.csv");
    const p = await previewDuplicates(db, org, parsed.allRows, PREVIEW.mapping);
    expect(p).toMatchObject({ totalRows: 5, existing: 3, unidentified: 1 });
    expect(p.matches.map((m) => [m.row, m.name, m.phoneLast4, m.via, m.leadName])).toEqual([
      [2, "Test Owner Three", null, "mojo", "Test Owner Three"],
      [3, "Test Owner Four", "0187", "phone", "Test Owner Four"],
      [4, "Test Owner Five", null, "name-address", "Test Owner Five"],
    ]);
    expect(JSON.stringify(p)).not.toContain("2125550187"); // never the whole number
  });

  it("writes nothing", async () => {
    const counts = async () => [await db.lead.count({ where: { organizationId: org } }), await db.contact.count({ where: { organizationId: org } }), await db.contactPhone.count({ where: { contact: { organizationId: org } } })];
    const before = await counts();
    await previewDuplicates(db, org, parseFile(Buffer.from(csv), "x.csv").allRows, PREVIEW.mapping);
    expect(await counts()).toEqual(before);
  });

  it("the commit then merges exactly those rows", async () => {
    const res = await commitImport(await batchFor(csv), "merge", PREVIEW, "c", { emit, db });
    expect(res).toMatchObject({ totalRows: 5, importedRows: 4, duplicateRows: 3, errorRows: 1 });
  });

  it("stops starting rows at its deadline or when the request is cancelled, and says how far it got", async () => {
    const rows = parseFile(Buffer.from(csv), "x.csv").allRows;
    const past = await previewDuplicates(db, org, rows, PREVIEW.mapping, { deadline: 0 });
    expect(past).toMatchObject({ totalRows: 5, checkedRows: 0, existing: 0, unidentified: 0, matches: [] });
    const cancelled = new AbortController();
    cancelled.abort();
    expect(await previewDuplicates(db, org, rows, PREVIEW.mapping, { signal: cancelled.signal })).toMatchObject({ totalRows: 5, checkedRows: 0 });
    // A clock that runs out after two rows have started.
    let ticks = 0;
    const partway = await previewDuplicates(db, org, rows, PREVIEW.mapping, { deadline: 2, now: () => ticks++ });
    expect(partway.checkedRows).toBe(2);
    expect(partway.totalRows).toBe(5);
    expect((await previewDuplicates(db, org, rows, PREVIEW.mapping, { deadline: Date.now() + 60_000 })).checkedRows).toBe(5);
  });

  it("a large file is checked in full", async () => {
    const rows = Array.from({ length: 600 }, (_, i) => ({ "Contact ID": i % 50 === 0 ? `${TAG}_p1` : `${TAG}_big${i}`, Name: `Test Owner ${i}`, Address: "", Phone: "" }));
    const p = await previewDuplicates(db, org, rows, PREVIEW.mapping);
    expect(p).toMatchObject({ totalRows: 600, checkedRows: 600, existing: 12, unidentified: 0 });
    expect(p.matches.length).toBeLessThanOrEqual(20);
  }, 60_000);
});
