import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { PrismaClient } from "@prisma/client";
import { prismaPerf } from "./setup/pg";
import { makeOrg, dropOrg } from "./setup/b45";
import { loadUploads } from "@/lib/core-data/leads/uploads";
import { sourceLabel } from "@/lib/ui/source";

// Brief 50 PR 14 (open item 6.16): a lead's Source reads as its upload's
// Source label, looked up against a real Postgres, and only in the lead's own
// organization. Two throwaway organizations; made-up labels and file names.

const TAG = `b50_pr14_${Date.now()}`;
let db: PrismaClient;
let org: string;
let other: string;

const upload = (organizationId: string, sourceLabel: string, filename: string) =>
  db.importBatch.create({
    data: { organizationId, userId: "user_test", sourceLabel, filename, storageKey: "test", status: "completed", createdAt: new Date("2026-10-19T02:30:00.000Z") },
  });

beforeAll(async () => {
  db = prismaPerf(2);
  await db.$connect();
  org = await makeOrg(db, TAG);
  other = await makeOrg(db, `${TAG}_other`);
});

afterAll(async () => {
  if (org) await dropOrg(db, org);
  if (other) await dropOrg(db, other);
  await db?.$disconnect();
});

describe("loadUploads", () => {
  it("finds this organization's uploads and never another's", async () => {
    const mine = await upload(org, "Mojo Export", "test-sellers.csv");
    const theirs = await upload(other, "Someone else's list", "other.csv");
    const uploads = await loadUploads(org, [`import:${mine.id}`, `import:${theirs.id}`, "manual", null], db);
    expect(Object.keys(uploads)).toEqual([mine.id]);
    expect(sourceLabel(`import:${mine.id}`, uploads)).toBe("Mojo Export");
    expect(sourceLabel(`import:${mine.id}`, uploads, { detail: true })).toBe("Mojo Export · uploaded Oct 18, 2026 · test-sellers.csv");
    expect(sourceLabel(`import:${theirs.id}`, uploads)).toBe("Upload");
  });
});
