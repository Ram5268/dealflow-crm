import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { PrismaClient } from "@prisma/client";
import { prismaPerf } from "./setup/pg";
import { putObject } from "@/lib/core-data/importer/storage";
import { commitImport } from "@/lib/core-data/importer/commit-worker";
import { claimImportCommit, getImportStatus, heldBy, importRunOf, mappingKey, type CommitClaim } from "@/lib/core-data/importer/batch";
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
const NAME_PHONE = mapping(col("Name", "Lead.name"), col("Phone", "ContactPhone.phone"));
const MOJO_NAME_ADDR_PHONE = mapping(col("MojoID", "Lead.mojoId"), col("Name", "Lead.name"), col("Address", "Lead.primaryAddressFull"), col("Phone", "ContactPhone.phone"));
// Brief 41.1: a claim starts a run; the commit gets its id.
const runIdOf = (c: CommitClaim) => (c.claimed ? c.runId : undefined);
const inAMinute = { now: () => Date.now() + 61_000 };

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
    await commitImport(id, "merge", PHONE_ONLY, "c", { emit, db, runId: claims.map(runIdOf).find(Boolean) });
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
    expect(await claimImportCommit(db, b.id, org, PHONE_ONLY)).toMatchObject({ claimed: true });
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
    const claim = await claimImportCommit(db, id, org, PHONE_ONLY);
    expect(claim).toMatchObject({ claimed: true });
    const claimed = await db.importBatch.findUniqueOrThrow({ where: { id } });
    expect(claimed.importedRows).toBe(doneFirst);
    let emits = 0;
    const counting = async () => { emits++; return { overflow: false, bytes: 0 } as EmitResult; };
    const res = await commitImport(id, "merge", PHONE_ONLY, "c", { emit: counting, db, runId: runIdOf(claim) });
    expect(res).toMatchObject({ totalRows: 6, importedRows: 6, duplicateRows: 0, errorRows: 0 });
    expect(emits).toBe(6 - doneFirst);
    for (let k = 0; k < 6; k++) expect(await leadsWithPhone(`+121255502${String(k).padStart(2, "0")}`)).toHaveLength(1);
  });

  it("a re-run whose mapping the AI proposed again (new wording, the custom field now existing) still continues", async () => {
    const rows = Array.from({ length: 6 }, (_, k) => `212-555-04${String(k).padStart(2, "0")},note ${k}`).join("\n");
    const id = await batchFor(`Phone,Notes\n${rows}\n`);
    const notesName = `${TAG} Notes`;
    const first = { mapping: [
      { column: "Phone", sampleValues: ["212-555-0400"], target: { kind: "standard_field", field: "ContactPhone.phone" }, confidence: 0.98, reasoning: "Looks like a phone number." },
      { column: "Notes", sampleValues: ["note 0"], target: { kind: "new_custom_field", name: notesName, type: "text" }, confidence: 0.7, reasoning: "Free text." },
    ], likelyDuplicates: [] } as unknown as MappingProposal;
    let t = 0;
    await expect(commitImport(id, "merge", first, "c", { emit, db, now: () => (t += 1000), timeLimitMs: 2_500 })).rejects.toThrow(/time limit/);
    const doneFirst = (await db.importBatch.findUniqueOrThrow({ where: { id } })).importedRows;
    expect(doneFirst).toBe(2);
    const def = await db.customFieldDefinition.findFirstOrThrow({ where: { organizationId: org, name: notesName } });
    // "Back to the import" asks the AI again: other wording and samples, and the
    // custom field the first run created now comes back as an existing one.
    const again = { mapping: [
      { column: "Notes", sampleValues: ["note 3"], target: { kind: "existing_custom_field", definitionId: def.id }, confidence: 0.9, reasoning: "Matches the existing Notes field." },
      { column: "Phone", sampleValues: ["212-555-0401"], target: { kind: "standard_field", field: "ContactPhone.phone" }, confidence: 0.95, reasoning: "Phone numbers." },
    ], likelyDuplicates: [] } as unknown as MappingProposal;
    const claim = await claimImportCommit(db, id, org, again);
    expect(claim).toMatchObject({ claimed: true });
    expect((await db.importBatch.findUniqueOrThrow({ where: { id } })).importedRows).toBe(doneFirst);
    let emits = 0;
    const counting = async () => { emits++; return { overflow: false, bytes: 0 } as EmitResult; };
    const res = await commitImport(id, "merge", again, "c", { emit: counting, db, runId: runIdOf(claim) });
    expect(res).toMatchObject({ totalRows: 6, importedRows: 6, duplicateRows: 0, errorRows: 0 });
    expect(emits).toBe(6 - doneFirst);
    for (let k = 0; k < 6; k++) {
      const [l] = await leadsWithPhone(`+121255504${String(k).padStart(2, "0")}`);
      expect(l).toBeDefined();
      const v = await db.customFieldValue.findUniqueOrThrow({ where: { definitionId_objectId: { definitionId: def.id, objectId: l.id } } });
      expect(v.valueText).toBe(`note ${k}`);
    }
  });

  it("a group of same-phone rows cut off mid-way resumes at its next row, so the counts stay exact", async () => {
    // Rows 1-4 share a phone (one group, run in order); rows 5 and 6 are others.
    const id = await batchFor(`Phone\n212-555-0310\n212-555-0310\n212-555-0310\n212-555-0310\n212-555-0311\n212-555-0312\n`);
    let t = 0;
    await expect(commitImport(id, "merge", PHONE_ONLY, "c", { emit, db, now: () => (t += 1000), timeLimitMs: 2_500 })).rejects.toThrow(/time limit/);
    const stopped = await db.importBatch.findUniqueOrThrow({ where: { id } });
    // The shared-phone group stopped after its first row; row 5 finished.
    expect(stopped).toMatchObject({ importedRows: 2, duplicateRows: 0 });
    expect(JSON.stringify(stopped.errorLog)).toContain('"resume":{"next":2,"partial":[[0,1]]}');
    const claim = await claimImportCommit(db, id, org, PHONE_ONLY);
    expect(claim).toMatchObject({ claimed: true });
    let emits = 0;
    const counting = async () => { emits++; return { overflow: false, bytes: 0 } as EmitResult; };
    const res = await commitImport(id, "merge", PHONE_ONLY, "c", { emit: counting, db, runId: runIdOf(claim) });
    // Exactly the 4 rows not yet done: 3 more of the group (merged) and row 6.
    expect(emits).toBe(4);
    expect(res).toMatchObject({ totalRows: 6, importedRows: 6, duplicateRows: 3, errorRows: 0 });
    for (const n of ["+12125550310", "+12125550311", "+12125550312"]) expect(await leadsWithPhone(n)).toHaveLength(1);
  });

  it("a different mapping after a time-limit stop starts again from row 1 (still without duplicates)", async () => {
    const id = await batchFor(`Phone\n212-555-0210\n212-555-0211\n212-555-0212\n`);
    let t = 0;
    await expect(commitImport(id, "merge", PHONE_ONLY, "c", { emit, db, now: () => (t += 1000), timeLimitMs: 1_500 })).rejects.toThrow(/time limit/);
    const other = mapping(col("Phone", "ContactPhone.phone"), col("Name", "Contact.name"));
    const claim = await claimImportCommit(db, id, org, other);
    expect(claim).toMatchObject({ claimed: true });
    const fresh = await db.importBatch.findUniqueOrThrow({ where: { id } });
    expect(fresh.importedRows).toBe(0);
    const res = await commitImport(id, "merge", other, "c", { emit, db, runId: runIdOf(claim) });
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

  it("a stop while a row's event is still being sent doesn't count that row twice on the re-run", async () => {
    const id = await batchFor("Phone\n212-555-0230\n212-555-0231\n");
    let calls = 0;
    const firstHangs = () => (++calls === 1 ? new Promise<EmitResult>(() => {}) : Promise.resolve({ overflow: false, bytes: 0 } as EmitResult));
    void commitImport(id, "merge", PHONE_ONLY, "c", { emit: firstHangs, db, watchdogMs: 15_000 }).catch(() => {});
    // Wait for both rows to be written (one then hangs sending its event), then
    // for the watchdog, instead of guessing how long the perf DB takes.
    const until = async (ok: () => Promise<boolean>, ms: number) => {
      for (const end = Date.now() + ms; Date.now() < end; await new Promise((r) => setTimeout(r, 250))) if (await ok()) return;
      throw new Error("timed out");
    };
    await until(async () => (await leadsWithPhone("+12125550230")).length === 1 && (await leadsWithPhone("+12125550231")).length === 1, 14_000);
    await until(async () => (await db.importBatch.findUniqueOrThrow({ where: { id } })).status === "failed", 20_000);
    const stopped = await db.importBatch.findUniqueOrThrow({ where: { id } });
    expect(stopped.status).toBe("failed");
    expect(stopped.importedRows).toBe(2); // both rows were counted (one's event never went out)
    // Brief 41.1: the stopped run may still be finishing a row, so a re-run
    // waits a minute after a "stopped responding" failure.
    expect(await claimImportCommit(db, id, org, PHONE_ONLY)).toMatchObject({ claimed: false, status: "failed", retryInSeconds: expect.any(Number) });
    const claim = await claimImportCommit(db, id, org, PHONE_ONLY, inAMinute);
    expect(claim).toMatchObject({ claimed: true });
    const res = await commitImport(id, "merge", PHONE_ONLY, "c", { emit, db, runId: runIdOf(claim) });
    expect(res).toMatchObject({ totalRows: 2, importedRows: 2, duplicateRows: 0, errorRows: 0 });
    for (const n of ["+12125550230", "+12125550231"]) expect(await leadsWithPhone(n)).toHaveLength(1);
  }, 60_000);

  it("the watchdog also covers a hang before any row (reading the batch or the file)", async () => {
    const id = await batchFor("Phone\n212-555-0221\n", "mapping_review");
    const claim = await claimImportCommit(db, id, org, PHONE_ONLY);
    const stuck = new Proxy(db, {
      get(target, prop) {
        const v = Reflect.get(target, prop);
        if (prop !== "importBatch") return typeof v === "function" ? v.bind(target) : v;
        return new Proxy(v, { get: (d, p) => (p === "findUniqueOrThrow" ? () => new Promise(() => {}) : Reflect.get(d, p)) });
      },
    }) as PrismaClient;
    void commitImport(id, "merge", PHONE_ONLY, "c", { emit, db: stuck, watchdogMs: 300, runId: runIdOf(claim) }).catch(() => {});
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
    expect(status).toMatchObject({ id, status: "completed", totalRows: 1, importedRows: 1, progress: 100, stalled: false, retryInSeconds: 0 });
    expect(status).not.toHaveProperty("sourceBlob");
    expect(status).not.toHaveProperty("mappingJson");
    expect(JSON.stringify(status).length).toBeLessThan(2_000);
    expect(await getImportStatus(db, id, "org_other")).toBeNull();
  });
});

describe("each run writes only while it holds the import (Brief 41.1, F1)", () => {
  it("Postgres applies the run filters: another run's writes and commit change nothing", async () => {
    const id = await batchFor("Phone\n212-555-0520\n", "mapping_review");
    const claim = await claimImportCommit(db, id, org, PHONE_ONLY);
    expect(claim).toMatchObject({ claimed: true, runId: expect.any(String) });
    const runId = runIdOf(claim)!;
    expect(importRunOf((await db.importBatch.findUniqueOrThrow({ where: { id } })).mappingJson)?.id).toBe(runId);
    // The JSON path filter on the run id, as every run write uses it.
    expect((await db.importBatch.updateMany({ where: heldBy(id, "another-run", ["importing", "failed"]), data: { totalRows: 99 } })).count).toBe(0);
    expect((await db.importBatch.updateMany({ where: heldBy(id, runId), data: { totalRows: 1 } })).count).toBe(1);
    await commitImport(id, "merge", PHONE_ONLY, "c", { emit, db, runId: "another-run" });
    expect(await leadsWithPhone("+12125550520")).toHaveLength(0);
    expect((await db.importBatch.findUniqueOrThrow({ where: { id } })).status).toBe("importing");
    const res = await commitImport(id, "merge", PHONE_ONLY, "c", { emit, db, runId });
    expect(res).toMatchObject({ totalRows: 1, importedRows: 1 });
    expect((await db.importBatch.findUniqueOrThrow({ where: { id } })).status).toBe("completed");
  });

  it("an import stuck at 'importing' with no progress for 10 minutes is claimed again once, from row 1", async () => {
    const id = await batchFor("Phone\n212-555-0521\n");
    const dead = { ...PHONE_ONLY, importRun: { id: "dead-run", beatAt: new Date(Date.now() - 11 * 60_000).toISOString() } };
    await db.importBatch.update({
      where: { id },
      data: { mappingJson: dead, importedRows: 1, errorLog: [{ row: 0, message: "Import stopped: x", resume: { next: 1, partial: [] }, mappingKey: mappingKey(PHONE_ONLY) }] },
    });
    expect(await getImportStatus(db, id, org)).toMatchObject({ status: "importing", stalled: true });
    // Compare-and-set on the whole stored mapping (with the dead run's heartbeat).
    const claims = await Promise.all([1, 2, 3].map(() => claimImportCommit(db, id, org, PHONE_ONLY)));
    expect(claims.filter((c) => c.claimed)).toHaveLength(1);
    const after = await db.importBatch.findUniqueOrThrow({ where: { id } });
    expect(after).toMatchObject({ status: "importing", importedRows: 0, errorLog: [] });
    expect(importRunOf(after.mappingJson)?.id).toBe(claims.map(runIdOf).find(Boolean));
    await commitImport(id, "merge", PHONE_ONLY, "c", { emit, db, runId: "dead-run" }); // the dead run wakes up: nothing
    expect(await leadsWithPhone("+12125550521")).toHaveLength(0);
    expect(await getImportStatus(db, id, org)).toMatchObject({ status: "importing", stalled: false });
  });

  it("a stuck import claimed before run ids existed (no mapping stored) counts from its upload", async () => {
    const b = await db.importBatch.create({
      data: { organizationId: org, userId, sourceLabel: TAG, filename: "x.csv", storageKey: "pending", status: "importing", createdAt: new Date(Date.now() - 11 * 60_000) },
    });
    expect(await claimImportCommit(db, b.id, org, PHONE_ONLY)).toMatchObject({ claimed: true });
  });
});

describe("a phone match whose names disagree is another person (Brief 41.1, F10)", () => {
  const seedNamed = (name: string, phone: string, extra: { address?: string; contacts?: string[] } = {}) =>
    db.lead.create({
      data: {
        organizationId: org, displayName: name, name: name === "Imported Lead" ? null : name,
        primaryAddressFull: extra.address ?? null, primaryAddressSummary: extra.address?.split(",")[0] ?? null,
        contacts: {
          create: [
            { organizationId: org, displayName: name, phones: { create: { phone, type: "mobile", isPrimary: true } } },
            ...(extra.contacts ?? []).map((c) => ({ organizationId: org, displayName: c, name: c })),
          ],
        },
      },
    });

  it("Bob's row doesn't give Alice his address and Mojo ID: it becomes his own lead", async () => {
    const alice = await seedNamed("Alice Conflict", "+12125550501");
    const res = await commitImport(await batchFor(`MojoID,Name,Address,Phone\n${TAG}_bob,Bob Conflict,5 Oak St,212-555-0501\n`), "merge", MOJO_NAME_ADDR_PHONE, "c", { emit, db });
    expect(res).toMatchObject({ importedRows: 1, duplicateRows: 0 });
    expect(await leadRow(alice.id)).toMatchObject({ name: "Alice Conflict", displayName: "Alice Conflict", primaryAddressFull: null, mojoId: null });
    expect(await db.lead.findFirstOrThrow({ where: { organizationId: org, mojoId: `${TAG}_bob` } })).toMatchObject({ name: "Bob Conflict", primaryAddressFull: "5 Oak St" });
    expect(await leadsWithPhone("+12125550501")).toHaveLength(2);
  });

  it("the same person spelled another way still merges and fills the blank address", async () => {
    const hank = await seedNamed("Hank Owner", "+12125550502");
    const res = await commitImport(await batchFor("Name,Address,Phone\n\"OWNER, Hank J.\",7 Ash St,212-555-0502\n"), "merge", NAME_ADDR_PHONE, "c", { emit, db });
    expect(res).toMatchObject({ importedRows: 1, duplicateRows: 1 });
    expect(await leadRow(hank.id)).toMatchObject({ name: "Hank Owner", primaryAddressFull: "7 Ash St" });
  });

  it("a lead with no real name ('Imported Lead') takes the row's name", async () => {
    const unnamed = await seedNamed("Imported Lead", "+12125550503");
    const res = await commitImport(await batchFor("Name,Phone\nIvy Owner,212-555-0503\n"), "merge", NAME_PHONE, "c", { emit, db });
    expect(res).toMatchObject({ importedRows: 1, duplicateRows: 1 });
    expect(await leadRow(unnamed.id)).toMatchObject({ name: "Ivy Owner", displayName: "Ivy Owner" });
  });

  it("a co-owner listed on the lead is the same household: merges", async () => {
    const jack = await seedNamed("Jack Owner", "+12125550504", { contacts: ["Jill Owner"] });
    const res = await commitImport(await batchFor("Name,Phone\nJill Owner,212-555-0504\n"), "merge", NAME_PHONE, "c", { emit, db });
    expect(res).toMatchObject({ importedRows: 1, duplicateRows: 1 });
    expect(await leadsWithPhone("+12125550504")).toEqual([expect.objectContaining({ id: jack.id })]);
  });

  it("the same street with another person's name on the phone: one lead, which only gets its blanks filled (Ryan's decision)", async () => {
    await seedLead("gina", { name: "Kim Owner", address: "8 Birch St, Brooklyn, NY 11201", status: "Hot", mojoId: null, phone: "+12125550505" });
    const before = await leadRow(lead.gina);
    const m = mapping(col("MojoID", "Lead.mojoId"), col("Name", "Lead.name"), col("Address", "Lead.primaryAddressFull"), col("Phone", "ContactPhone.phone"), col("Status", "Lead.statusLabel"));
    const csv = `MojoID,Name,Address,Phone,Status\n${TAG}_lee,Lee Other,8 Birch Street,212-555-0505,Cold\n`;
    const res = await commitImport(await batchFor(csv), "merge", m, "c", { emit, db });
    expect(res).toMatchObject({ importedRows: 1, duplicateRows: 1 });
    expect(await leadsWithPhone("+12125550505")).toHaveLength(1);
    // Never renamed, its status and address kept; the blank Mojo ID filled.
    expect(await leadRow(lead.gina)).toEqual({ ...before, mojoId: `${TAG}_lee` });
    // "Keep my name for good": the same file again now matches by Mojo ID and
    // still only fills blanks.
    expect(await commitImport(await batchFor(csv), "merge", m, "c", { emit, db })).toMatchObject({ importedRows: 1, duplicateRows: 1 });
    expect(await leadRow(lead.gina)).toEqual({ ...before, mojoId: `${TAG}_lee` });
  });
});

describe("another unit or a suffix word is another property (Brief 41.1, F10)", () => {
  const cases: Array<[string, string, string]> = [
    ["unit #3 vs Apt 4", "361 Degraw St # 3, Brooklyn, NY 11217", "361 Degraw St Apt 4, Brooklyn"],
    ["a street vs its Extension", "12 Main St Extension, Brooklyn, NY", "12 Main St"],
    ["bare unit 4B vs 5A", "123 Main St 4B, Brooklyn, NY", "123 Main St 5A, Brooklyn, NY"],
  ];
  cases.forEach(([why, stored, incoming], k) => {
    it(`${why}: a new lead; the stored one is untouched`, async () => {
      const phone = `+121255505${String(10 + k)}`;
      await seedLead("gina", { name: `Mona Owner ${k}`, address: stored, status: "Hot", mojoId: null, phone });
      const before = await leadRow(lead.gina);
      const csv = `Name,Address,Phone\nMona Owner ${k},${incoming.includes(",") ? `"${incoming}"` : incoming},${phone.slice(2)}\n`;
      const res = await commitImport(await batchFor(csv), "merge", NAME_ADDR_PHONE, "c", { emit, db });
      expect(res).toMatchObject({ importedRows: 1, duplicateRows: 0 });
      expect(await leadRow(lead.gina)).toEqual(before);
      expect(await leadsWithPhone(phone)).toHaveLength(2);
    });
  });

  it("a stored line with no street name (\"12, Brooklyn, NY\") counts as blank: the same owner fills it in", async () => {
    const phone = "+12125550519";
    await seedLead("gina", { name: "Nora Owner", address: "12, Brooklyn, NY", status: "Hot", mojoId: null, phone });
    const res = await commitImport(await batchFor(`Name,Address,Phone,Status\nNora Owner,12 Main St,${phone.slice(2)},Cold\n`), "merge", mapping(col("Name", "Lead.name"), col("Address", "Lead.primaryAddressFull"), col("Phone", "ContactPhone.phone"), col("Status", "Lead.statusLabel")), "c", { emit, db });
    expect(res).toMatchObject({ importedRows: 1, duplicateRows: 1 });
    expect(await leadsWithPhone(phone)).toHaveLength(1);
    // A fill-only merge: the address is filled in; the status isn't changed.
    expect(await leadRow(lead.gina)).toMatchObject({ name: "Nora Owner", primaryAddressFull: "12 Main St", statusLabel: "Hot" });
  });
});
