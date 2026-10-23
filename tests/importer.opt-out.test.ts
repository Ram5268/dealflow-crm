import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { PrismaClient } from "@prisma/client";
import { prismaPerf } from "./setup/pg";
import { putObject } from "@/lib/core-data/importer/storage";
import { commitImport } from "@/lib/core-data/importer/commit-worker";
import type { MappingProposal } from "@/lib/core-data/importer/ai-mapping";
import type { EmitResult } from "@/lib/core-data/events/emit";

// Brief 50 PR 17 (the planner's review, Brief 50 Revision 2, 2026-10-23), on
// Postgres inside a throwaway organization: an upload that merges a row into a
// lead that has a number on the Do not contact list puts the row's new numbers
// on the list too, with the same reason, in the same transaction as adding
// them, and says so on the lead's timeline (last 4 digits only). The
// executor's follow-up: the same for a brand-new lead made from a row that
// holds a listed number and others. The list
// exists because a homeowner asked not to be contacted; nothing may contact a
// lead [Ryan]. Made-up people and 555-01xx numbers only.
const TAG = `b50_pr17_${Date.now()}`;
const emit = async (): Promise<EmitResult> => ({ overflow: false, bytes: 0 });
let db: PrismaClient;
let org: string;
let userId: string;

const col = (column: string, field: string) => ({
  column, sampleValues: [], target: { kind: "standard_field" as const, field }, confidence: 1, reasoning: "",
});
const PHONES = { mapping: [col("Phone 1", "ContactPhone.phone"), col("Phone 2", "ContactPhone.phone")], likelyDuplicates: [] } as unknown as MappingProposal;
const MOJO_PHONES = { mapping: [col("MojoID", "Lead.mojoId"), col("Phone 1", "ContactPhone.phone"), col("Phone 2", "ContactPhone.phone")], likelyDuplicates: [] } as unknown as MappingProposal;

async function batchFor(csv: string, on: PrismaClient = db): Promise<string> {
  const b = await on.importBatch.create({
    data: { organizationId: org, userId, sourceLabel: TAG, filename: "x.csv", storageKey: "pending", status: "mapping_review" },
  });
  const key = `imports/${org}/${b.id}/x.csv`;
  await putObject(key, Buffer.from(csv), on);
  await on.importBatch.update({ where: { id: b.id }, data: { storageKey: key } });
  return b.id;
}

async function seedLead(mojoId: string, phone: string): Promise<string> {
  const lead = await db.lead.create({
    data: {
      organizationId: org,
      displayName: `Test Owner ${mojoId.slice(-2)}`,
      mojoId,
      contacts: { create: { organizationId: org, displayName: "Test Owner", phones: { create: { phone, type: "mobile", isPrimary: true } } } },
    },
  });
  return lead.id;
}
const optOut = (phone: string, reason: string | null) =>
  db.dncSuppression.create({ data: { organizationId: org, phone, source: "internal", addedBy: "settings-do-not-contact", reason } });
const phonesOf = async (leadId: string) =>
  (await db.contactPhone.findMany({ where: { contact: { leadId } }, orderBy: { phone: "asc" } })).map((p) => p.phone);
const entries = (leadId: string) => db.activity.findMany({ where: { leadId } });

// The same database, except that writing an opt-out fails inside a transaction.
function failingOptOutWrites(real: PrismaClient): PrismaClient {
  const failDnc = (tx: object) =>
    new Proxy(tx, {
      get(t, p, r) {
        if (p !== "dncSuppression") return Reflect.get(t, p, r);
        return new Proxy(Reflect.get(t, p, r) as object, {
          get(d, q, rr) {
            if (q === "createMany" || q === "create" || q === "upsert") return async () => { throw new Error("opt-out write failed (test)"); };
            return Reflect.get(d, q, rr);
          },
        });
      },
    });
  return new Proxy(real, {
    get(target, prop, receiver) {
      if (prop !== "$transaction") return Reflect.get(target, prop, receiver);
      return (arg: unknown, opts?: unknown) =>
        typeof arg === "function"
          ? target.$transaction((tx) => (arg as (tx: unknown) => Promise<unknown>)(failDnc(tx)), opts as never)
          : target.$transaction(arg as never, opts as never);
    },
  }) as PrismaClient;
}

beforeAll(async () => {
  db = prismaPerf(4);
  await db.$connect();
  org = (await db.organization.create({ data: { slug: TAG, name: "Brief 50 PR 17 import test" } })).id;
  userId = (await db.user.create({ data: { organizationId: org, email: `${TAG}@example.com`, displayName: "Importer" } })).id;
}, 120_000);

afterAll(async () => {
  if (org) {
    await db.activity.deleteMany({ where: { organizationId: org } });
    await db.dncSuppression.deleteMany({ where: { organizationId: org } });
    await db.lead.deleteMany({ where: { organizationId: org } });
    await db.importBatch.deleteMany({ where: { organizationId: org } });
    await db.user.deleteMany({ where: { organizationId: org } });
    await db.organization.delete({ where: { id: org } });
  }
  await db?.$disconnect();
});

// Executor's follow-up: a brand-new lead from an upload (or "add anyway").
describe("an upload creating a new lead with a number on the Do not contact list", () => {
  const leadByMojo = (mojoId: string) => db.lead.findFirst({ where: { organizationId: org, mojoId }, orderBy: { createdAt: "desc" } });

  it("puts the row's other numbers on the list too, with the same reason, and notes it on the new lead", async () => {
    await optOut("+13475550181", "Asked not to be called");
    const csv = `MojoID,Phone 1,Phone 2\n${TAG}_n1,347-555-0181,347-555-0182\n`;
    expect(await commitImport(await batchFor(csv), "merge", MOJO_PHONES, "c", { emit, db })).toMatchObject({ importedRows: 1, duplicateRows: 0, errorRows: 0 });
    const lead = (await leadByMojo(`${TAG}_n1`))!;
    expect(await phonesOf(lead.id)).toEqual(["+13475550181", "+13475550182"]);
    const added = await db.dncSuppression.findFirst({ where: { organizationId: org, phone: "+13475550182" } });
    expect(added).toMatchObject({ source: "internal", reason: "Asked not to be called", addedBy: "same-lead-opt-out:import" });
    const history = await entries(lead.id);
    expect(history.map((h) => [h.type, h.bodyText])).toEqual([["Edit", "A phone from an upload put on Do not contact (…0182), like another number on this lead"]]);
  });

  it("\"add anyway\" does the same for the extra lead it makes", async () => {
    // The row matches the lead by phone; "add anyway" makes a second lead.
    await seedLead(`${TAG}_n2`, "+13475550183");
    await optOut("+13475550183", "Texted STOP");
    const csv = `Phone 1,Phone 2\n347-555-0183,347-555-0184\n`;
    expect(await commitImport(await batchFor(csv), "add-anyway", PHONES, "c", { emit, db })).toMatchObject({ importedRows: 1, errorRows: 0 });
    expect(await db.lead.count({ where: { organizationId: org, contacts: { some: { phones: { some: { phone: "+13475550183" } } } } } })).toBe(2);
    expect(await db.dncSuppression.findFirst({ where: { organizationId: org, phone: "+13475550184" } })).toMatchObject({ reason: "Texted STOP", addedBy: "same-lead-opt-out:import" });
  });

  it("if putting a number on the list fails, the lead isn't created either (one transaction), and the row is reported", async () => {
    await optOut("+13475550187", "Asked not to be called");
    const failing = failingOptOutWrites(db);
    const csv = `MojoID,Phone 1,Phone 2\n${TAG}_n3,347-555-0187,347-555-0188\n`;
    const res = await commitImport(await batchFor(csv, failing), "merge", MOJO_PHONES, "c", { emit, db: failing });
    expect(res).toMatchObject({ importedRows: 0, errorRows: 1 });
    expect(await db.lead.count({ where: { organizationId: org, mojoId: `${TAG}_n3` } })).toBe(0);
    expect(await db.dncSuppression.count({ where: { organizationId: org, phone: "+13475550188" } })).toBe(0);
  });

  it("a new lead with no Do not contact number is unaffected, and a one-number row never looks at the list", async () => {
    let lookups = 0;
    const counting = new Proxy(db, {
      get(target, prop, receiver) {
        if (prop !== "dncSuppression") return Reflect.get(target, prop, receiver);
        return new Proxy(Reflect.get(target, prop, receiver) as object, {
          get(d, q, r) {
            if (q === "findMany" || q === "findFirst") lookups++;
            return Reflect.get(d, q, r);
          },
        });
      },
    }) as PrismaClient;
    await commitImport(await batchFor(`MojoID,Phone 1,Phone 2\n${TAG}_n4,347-555-0189,\n`, counting), "merge", MOJO_PHONES, "c", { emit, db: counting });
    expect(lookups).toBe(0);
    await commitImport(await batchFor(`MojoID,Phone 1,Phone 2\n${TAG}_n5,347-555-0190,347-555-0191\n`), "merge", MOJO_PHONES, "c", { emit, db });
    const lead = (await leadByMojo(`${TAG}_n5`))!;
    expect(await phonesOf(lead.id)).toEqual(["+13475550190", "+13475550191"]);
    expect(await db.dncSuppression.count({ where: { organizationId: org, phone: { in: ["+13475550189", "+13475550190", "+13475550191"] } } })).toBe(0);
    expect(await entries(lead.id)).toHaveLength(0);
  });
});

describe("an upload merging into a lead that has a Do not contact number", () => {
  it("puts the row's new numbers on the list too, with the same reason, and notes it on the lead (last 4 digits only)", async () => {
    const leadId = await seedLead(`${TAG}_m1`, "+13475550171");
    await optOut("+13475550171", "Asked not to be called");
    const csv = `MojoID,Phone 1,Phone 2\n${TAG}_m1,347-555-0171,347-555-0172\n`;
    expect(await commitImport(await batchFor(csv), "merge", MOJO_PHONES, "c", { emit, db })).toMatchObject({ importedRows: 1, duplicateRows: 1, errorRows: 0 });

    expect(await phonesOf(leadId)).toEqual(["+13475550171", "+13475550172"]);
    const rows = await db.dncSuppression.findMany({ where: { organizationId: org, phone: { in: ["+13475550171", "+13475550172"] } }, orderBy: { phone: "asc" } });
    expect(rows.map((r) => [r.phone, r.source, r.reason, r.addedBy])).toEqual([
      ["+13475550171", "internal", "Asked not to be called", "settings-do-not-contact"],
      ["+13475550172", "internal", "Asked not to be called", "same-lead-opt-out:import"],
    ]);
    const history = await entries(leadId);
    expect(history).toHaveLength(1);
    expect(history[0].type).toBe("Edit");
    expect(history[0].bodyText).toBe("A phone from an upload put on Do not contact (…0172), like another number on this lead");
  });

  it("an opt-out stored before PR 13 as \"+\" and the 10 digits counts too", async () => {
    const leadId = await seedLead(`${TAG}_m2`, "+13475550173");
    await optOut("+3475550173", null);
    await commitImport(await batchFor(`MojoID,Phone 1,Phone 2\n${TAG}_m2,347-555-0174,\n`), "merge", MOJO_PHONES, "c", { emit, db });
    expect(await phonesOf(leadId)).toEqual(["+13475550173", "+13475550174"]);
    expect(await db.dncSuppression.count({ where: { organizationId: org, phone: "+13475550174", addedBy: "same-lead-opt-out:import" } })).toBe(1);
  });

  it("if putting a number on the list fails, the number isn't added either (one transaction), and the row is reported", async () => {
    const leadId = await seedLead(`${TAG}_m3`, "+13475550175");
    await optOut("+13475550175", "Asked not to be called");
    const failing = failingOptOutWrites(db);
    const res = await commitImport(await batchFor(`MojoID,Phone 1,Phone 2\n${TAG}_m3,347-555-0176,\n`, failing), "merge", MOJO_PHONES, "c", { emit, db: failing });
    expect(res).toMatchObject({ importedRows: 0, errorRows: 1 });
    expect(await phonesOf(leadId)).toEqual(["+13475550175"]);
    expect(await db.dncSuppression.count({ where: { organizationId: org, phone: "+13475550176" } })).toBe(0);
    expect(await entries(leadId)).toHaveLength(0);
  });

  // Review round 1: the other way round.
  it("a row bringing a number on the list puts the lead's other numbers on it too", async () => {
    const leadId = await seedLead(`${TAG}_m5`, "+13475550143");
    await optOut("+13475550144", "Texted STOP");
    await commitImport(await batchFor(`MojoID,Phone 1,Phone 2\n${TAG}_m5,347-555-0144,347-555-0145\n`), "merge", MOJO_PHONES, "c", { emit, db });
    expect(await phonesOf(leadId)).toEqual(["+13475550143", "+13475550144", "+13475550145"]);
    const rows = await db.dncSuppression.findMany({ where: { organizationId: org, phone: { in: ["+13475550143", "+13475550145"] } }, orderBy: { phone: "asc" } });
    expect(rows.map((r) => [r.phone, r.reason, r.addedBy])).toEqual([
      ["+13475550143", "Texted STOP", "same-lead-opt-out:import"],
      ["+13475550145", "Texted STOP", "same-lead-opt-out:import"],
    ]);
    expect((await entries(leadId)).map((h) => h.bodyText)).toEqual([
      "A phone from an upload put on Do not contact (…0145), like another number on this lead\nPut on Do not contact (…0143), like a number just added to this lead",
    ]);
  });

  it("a lead with no Do not contact number is unaffected", async () => {
    const leadId = await seedLead(`${TAG}_m4`, "+13475550177");
    await commitImport(await batchFor(`MojoID,Phone 1,Phone 2\n${TAG}_m4,347-555-0178,\n`), "merge", MOJO_PHONES, "c", { emit, db });
    expect(await phonesOf(leadId)).toEqual(["+13475550177", "+13475550178"]);
    expect(await db.dncSuppression.count({ where: { organizationId: org, phone: { in: ["+13475550177", "+13475550178"] } } })).toBe(0);
    expect(await entries(leadId)).toHaveLength(0);
  });
});
