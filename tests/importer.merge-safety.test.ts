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
const lead: Record<"alice" | "bob" | "carol" | "ellaA" | "ellaB" | "gina", string> = { alice: "", bob: "", carol: "", ellaA: "", ellaB: "", gina: "" };

const col = (column: string, field: string) => ({
  column, sampleValues: [], target: { kind: "standard_field" as const, field }, confidence: 1, reasoning: "",
});
const mapping = (...cols: ReturnType<typeof col>[]): MappingProposal => ({ mapping: cols, likelyDuplicates: [] } as unknown as MappingProposal);
const PHONE_ONLY = mapping(col("Phone", "ContactPhone.phone"));
const MOJO_NAME = mapping(col("MojoID", "Lead.mojoId"), col("Name", "Lead.name"));
const MOJO_NAME_PHONE = mapping(col("MojoID", "Lead.mojoId"), col("Name", "Lead.name"), col("Phone", "ContactPhone.phone"));
const MOJO_PHONE = mapping(col("MojoID", "Lead.mojoId"), col("Phone", "ContactPhone.phone"));
const MOJO_ADDR_PHONE = mapping(col("MojoID", "Lead.mojoId"), col("Address", "Lead.primaryAddressFull"), col("Phone", "ContactPhone.phone"));
const NAME_ADDR_PHONE = mapping(col("Name", "Lead.name"), col("Address", "Lead.primaryAddressFull"), col("Phone", "ContactPhone.phone"));
const NAME_ADDR = mapping(col("Name", "Lead.name"), col("Address", "Lead.primaryAddressFull"));

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
  // One owner, two properties, one phone.
  await seedLead("ellaA", { name: "Ella Owner", address: "1 Pine St, Brooklyn, NY 11201", status: "Hot", mojoId: `${TAG}_e1`, phone: "+12125550160" });
  await seedLead("ellaB", { name: "Ella Owner", address: "2 Pine St, Brooklyn, NY 11201", status: "Warm", mojoId: `${TAG}_e2`, phone: "+12125550160" });
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

  it("a Mojo ID with no address can't be confirmed for a lead that has one: a new lead, the old one untouched", async () => {
    const before = await leadRow(lead.carol);
    await commitImport(await batchFor(`MojoID,Phone\n${TAG}_m30,212-555-0103\n`), "merge", MOJO_PHONE, "c", { emit, db });
    expect(await leadRow(lead.carol)).toEqual(before);
    expect((await leadsWithPhone("+12125550103")).map((l) => l.mojoId).sort()).toEqual([`${TAG}_m30`, null].sort());
  });

  it("a matched lead with no Mojo ID gets the file's Mojo ID when the street matches; nothing else is blanked", async () => {
    const before = await leadRow(lead.carol);
    await commitImport(await batchFor(`MojoID,Address,Phone\n${TAG}_m3,30 Elm Street,212-555-0103\n`), "merge", MOJO_ADDR_PHONE, "c", { emit, db });
    expect(await leadRow(lead.carol)).toEqual({ ...before, mojoId: `${TAG}_m3` });
  });

  it("an owner with two properties on one phone: each row lands on its own property, a third is new", async () => {
    const a = await leadRow(lead.ellaA);
    const b = await leadRow(lead.ellaB);
    const csv = "Name,Address,Phone\nElla Owner,2 Pine Street,212-555-0160\nElla Owner,3 Pine St,212-555-0160\n";
    const res = await commitImport(await batchFor(csv), "merge", NAME_ADDR_PHONE, "c", { emit, db });
    expect(res).toMatchObject({ totalRows: 2, importedRows: 2, duplicateRows: 1 });
    expect(await leadRow(lead.ellaA)).toEqual(a); // property A is never touched
    expect(await leadRow(lead.ellaB)).toEqual(b); // same street: its fuller address stays
    const third = await db.lead.findMany({ where: { organizationId: org, primaryAddressFull: "3 Pine St" } });
    expect(third).toHaveLength(1);
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
  it("10 rows with the same new phone make one lead", async () => {
    const rows = Array.from({ length: 10 }, () => "212-555-0199").join("\n");
    const res = await commitImport(await batchFor(`Phone\n${rows}\n`), "merge", PHONE_ONLY, "c", { emit, db });
    expect(res).toMatchObject({ totalRows: 10, importedRows: 10, duplicateRows: 9, errorRows: 0 });
    expect(await leadsWithPhone("+12125550199")).toHaveLength(1);
  });

  it("a name + address row and a phone row for the same owner make one lead", async () => {
    const csv = "Name,Address,Phone\nFrank Owner,9 Birch St,212-555-0170\nFrank Owner,9 Birch St,\n";
    const res = await commitImport(await batchFor(csv), "merge", NAME_ADDR_PHONE, "c", { emit, db });
    expect(res).toMatchObject({ totalRows: 2, importedRows: 2, duplicateRows: 1 });
    expect(await db.lead.count({ where: { organizationId: org, displayName: "Frank Owner" } })).toBe(1);
  });

  it("phone-only rows with new numbers become new leads, never piled onto an 'Imported Lead' or a same-name lead", async () => {
    await db.lead.create({ data: { organizationId: org, displayName: "Imported Lead" } }); // an addressless placeholder lead
    await db.lead.create({ data: { organizationId: org, displayName: "Maria Lopez", name: "Maria Lopez" } }); // addressless, no phone
    const nums = Array.from({ length: 5 }, (_, k) => `212-555-03${String(k).padStart(2, "0")}`);
    const res = await commitImport(await batchFor(`Phone\n${nums.join("\n")}\n`), "merge", PHONE_ONLY, "c", { emit, db });
    expect(res).toMatchObject({ totalRows: 5, importedRows: 5, duplicateRows: 0 });
    for (const n of nums) expect(await leadsWithPhone(`+1${n.replace(/-/g, "")}`)).toHaveLength(1);
    const NAME_PHONE = mapping(col("Name", "Lead.name"), col("Phone", "ContactPhone.phone"));
    const res2 = await commitImport(await batchFor("Name,Phone\nMaria Lopez,212-555-0390\n"), "merge", NAME_PHONE, "c", { emit, db });
    expect(res2).toMatchObject({ importedRows: 1, duplicateRows: 0 }); // a new number is a new lead, not the other Maria
    expect(await db.lead.count({ where: { organizationId: org, displayName: "Maria Lopez" } })).toBe(2);
  });

  it("a one-cell address with no comma matches the same street", async () => {
    await seedLead("gina", { name: "Gina Owner", address: "4 Cedar St, Brooklyn, NY 11201", status: "Hot", mojoId: null, phone: "+12125550180" });
    const before = await leadRow(lead.gina);
    const res = await commitImport(await batchFor("Name,Address,Phone\nGina Owner,4 Cedar St Brooklyn NY 11201,212-555-0180\n"), "merge", NAME_ADDR_PHONE, "c", { emit, db });
    expect(res).toMatchObject({ importedRows: 1, duplicateRows: 1 });
    expect(await leadRow(lead.gina)).toEqual(before);
  });

  it("a lead named by hand (displayName only) isn't renamed by a match it can't confirm", async () => {
    const hand = await db.lead.create({
      data: {
        organizationId: org, displayName: "Paul Manual",
        contacts: { create: { organizationId: org, displayName: "Paul Manual", phones: { create: { phone: "+12125550181", type: "mobile" } } } },
      },
    });
    const NAME_PHONE = mapping(col("Name", "Lead.name"), col("Phone", "ContactPhone.phone"));
    await commitImport(await batchFor("Name,Phone\nSomeone Else,212-555-0181\n"), "merge", NAME_PHONE, "c", { emit, db });
    expect((await db.lead.findUniqueOrThrow({ where: { id: hand.id } })).displayName).toBe("Paul Manual");
  });

  it("a row with nothing to identify it is an error row, not a mystery lead", async () => {
    const id = await batchFor("Phone\nnot a number\n");
    const res = await commitImport(id, "merge", PHONE_ONLY, "c", { emit, db });
    expect(res).toMatchObject({ totalRows: 1, importedRows: 0, errorRows: 1 });
    expect(await db.lead.count({ where: { organizationId: org, source: `import:${id}` } })).toBe(0);
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
    const claims = await Promise.all([1, 2, 3].map(() => claimImportCommit(db, id, org, PHONE_ONLY)));
    expect(claims.filter((c) => c.claimed)).toHaveLength(1);
    expect(claims.filter((c) => !c.claimed)).toEqual([{ claimed: false, status: "importing" }, { claimed: false, status: "importing" }]);
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

  it("an import that runs out of time stops, is marked failed, and a re-run continues where it stopped", async () => {
    const rows = Array.from({ length: 6 }, (_, k) => `212-555-02${String(k).padStart(2, "0")}`).join("\n");
    const id = await batchFor(`Phone\n${rows}\n`);
    let t = 0;
    const clock = () => (t += 1000); // each check advances one second
    await expect(commitImport(id, "merge", PHONE_ONLY, "c", { emit, db, now: clock, timeLimitMs: 2_500 })).rejects.toThrow(/time limit reached after \d+ of 6 rows/);
    const stopped = await db.importBatch.findUniqueOrThrow({ where: { id } });
    expect(stopped.status).toBe("failed");
    expect(JSON.stringify(stopped.errorLog)).toMatch(/Import stopped: time limit reached/);
    const doneFirst = stopped.importedRows;
    expect(doneFirst).toBeGreaterThan(0);
    expect(doneFirst).toBeLessThan(6);
    // Re-run with the same mapping: it keeps the counts and only does the rest.
    expect(await claimImportCommit(db, id, org, PHONE_ONLY)).toEqual({ claimed: true });
    const claimed = await db.importBatch.findUniqueOrThrow({ where: { id } });
    expect(claimed.importedRows).toBe(doneFirst);
    let emits = 0;
    const counting = async () => { emits++; return { overflow: false, bytes: 0 } as EmitResult; };
    const res = await commitImport(id, "merge", PHONE_ONLY, "c", { emit: counting, db });
    expect(res).toMatchObject({ totalRows: 6, importedRows: 6, duplicateRows: 0, errorRows: 0 });
    expect(emits).toBe(6 - doneFirst);
    for (let k = 0; k < 6; k++) expect(await leadsWithPhone(`+121255502${String(k).padStart(2, "0")}`)).toHaveLength(1);
  });

  it("a different mapping after a time-limit stop starts again from row 1 (still without duplicates)", async () => {
    const id = await batchFor(`Phone\n212-555-0210\n212-555-0211\n212-555-0212\n`);
    let t = 0;
    await expect(commitImport(id, "merge", PHONE_ONLY, "c", { emit, db, now: () => (t += 1000), timeLimitMs: 1_500 })).rejects.toThrow(/time limit/);
    const other = mapping(col("Phone", "ContactPhone.phone"), col("Name", "Contact.name"));
    expect(await claimImportCommit(db, id, org, other)).toEqual({ claimed: true });
    const fresh = await db.importBatch.findUniqueOrThrow({ where: { id } });
    expect(fresh.importedRows).toBe(0);
    const res = await commitImport(id, "merge", other, "c", { emit, db });
    expect(res).toMatchObject({ totalRows: 3, importedRows: 3 });
    for (const n of ["+12125550210", "+12125550211", "+12125550212"]) expect(await leadsWithPhone(n)).toHaveLength(1);
  });

  it("a query that hangs past the limit still leaves the batch marked failed (watchdog)", async () => {
    const id = await batchFor("Phone\n212-555-0220\n");
    const hang = () => new Promise<EmitResult>(() => {}); // never settles
    void commitImport(id, "merge", PHONE_ONLY, "c", { emit: hang, db, watchdogMs: 300 }).catch(() => {});
    await new Promise((r) => setTimeout(r, 3_000));
    const b = await db.importBatch.findUniqueOrThrow({ where: { id } });
    expect(b.status).toBe("failed");
    expect(JSON.stringify(b.errorLog)).toMatch(/stopped responding/);
  });

  it("re-running a completed batch changes nothing", async () => {
    const id = await batchFor("Phone\n212-555-0140\n");
    const first = await commitImport(id, "merge", PHONE_ONLY, "c", { emit, db });
    const again = await commitImport(id, "merge", PHONE_ONLY, "c", { emit, db });
    expect(again).toEqual(first);
    expect(await leadsWithPhone("+12125550140")).toHaveLength(1);
  });
});

describe("custom values on merge (Brief 41 review)", () => {
  it("a cell that isn't valid for its field keeps the lead's existing value and is logged", async () => {
    const def = await db.customFieldDefinition.create({ data: { organizationId: org, objectType: "lead", name: `${TAG} Year Built`, type: "number", displayOrder: 99 } });
    await db.customFieldValue.create({ data: { organizationId: org, definitionId: def.id, objectType: "lead", objectId: lead.alice, valueNumber: 1920 } });
    const m = { mapping: [col("MojoID", "Lead.mojoId"), { column: "Year", sampleValues: [], target: { kind: "existing_custom_field" as const, definitionId: def.id }, confidence: 1, reasoning: "" }], likelyDuplicates: [] } as unknown as MappingProposal;
    const id = await batchFor(`MojoID,Year\n${TAG}_m1,N/A\n`);
    await commitImport(id, "merge", m, "c", { emit, db });
    const v = await db.customFieldValue.findUniqueOrThrow({ where: { definitionId_objectId: { definitionId: def.id, objectId: lead.alice } } });
    expect(v.valueNumber).toBe(1920);
    expect(JSON.stringify((await db.importBatch.findUniqueOrThrow({ where: { id } })).errorLog)).toMatch(/isn't a valid number/);
    // a valid value for the same property does update it
    await commitImport(await batchFor(`MojoID,Year\n${TAG}_m1,1925\n`), "merge", m, "c", { emit, db });
    expect((await db.customFieldValue.findUniqueOrThrow({ where: { definitionId_objectId: { definitionId: def.id, objectId: lead.alice } } })).valueNumber).toBe(1925);
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
