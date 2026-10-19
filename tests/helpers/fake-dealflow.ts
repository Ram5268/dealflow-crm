// Brief 50 (PR 11): a DealFlow-shaped scratch schema on the test Postgres, so
// the CRM's real DealFlow reads (sync.ts, through the real read-only client)
// can run in suite 1. Only the tables and columns those statements name, with
// DealFlow's column types (DealFlow prisma/schema.prisma, main 1078e76; a
// Prisma enum is text here). The read-only client reaches the schema through
// search_path (fakeDealflowUrl), so nothing here is the CRM's own tables.
// Made-up rows only: no real homeowner, address or phone.
import type pg from "pg";

export function fakeDealflowUrl(testDbUrl: string, schema: string): string {
  const url = new URL(testDbUrl);
  url.searchParams.set("options", `-c search_path=${schema}`);
  return url.toString();
}

export async function createFakeDealflow(admin: pg.Pool, schema: string): Promise<void> {
  const s = `"${schema}"`;
  await admin.query(`CREATE SCHEMA ${s}`);
  await admin.query(`CREATE TABLE ${s}."Organization" (
    "id" text PRIMARY KEY, "slug" text NOT NULL UNIQUE, "name" text NOT NULL DEFAULT 'Fake DealFlow org')`);
  await admin.query(`CREATE TABLE ${s}."MojoContact" (
    "id" text PRIMARY KEY, "organizationId" text NOT NULL, "mojoId" text NOT NULL UNIQUE,
    "fullName" text NOT NULL DEFAULT 'Test Owner', "neighborhood" text, "initialNeighborhood" text,
    "bedsMin" integer, "bedsMax" integer, "budgetMin" double precision, "budgetMax" double precision,
    "cashOnly" boolean, "isTestData" boolean NOT NULL DEFAULT false, "metadata" jsonb)`);
  await admin.query(`CREATE TABLE ${s}."Match" (
    "id" text PRIMARY KEY, "organizationId" text NOT NULL, "counterpartId" text NOT NULL,
    "counterpartType" text NOT NULL, "score" integer NOT NULL, "reason" text, "tier" text,
    "captureStatus" text, "matchFitConfidence" text)`);
  await admin.query(`CREATE TABLE ${s}."ExtractedOpportunity" (
    "id" text PRIMARY KEY, "organizationId" text NOT NULL, "neighborhood" text, "price" double precision,
    "minPrice" double precision, "maxPrice" double precision, "beds" double precision, "sourceAgentName" text,
    "sourceBrokerage" text, "neighborhoods" text[] NOT NULL DEFAULT '{}', "propertyTypes" text[] NOT NULL DEFAULT '{}',
    "minBeds" integer, "maxBeds" integer, "buyerArchetype" text, "isTestData" boolean NOT NULL DEFAULT false)`);
  await admin.query(`CREATE TABLE ${s}."CallQueueEntry" (
    "id" text PRIMARY KEY, "organizationId" text NOT NULL, "contactId" text NOT NULL, "rank" integer NOT NULL,
    "priorityScore" integer NOT NULL, "reason" text NOT NULL, "primaryMatchId" text,
    "contributingMatchIds" text[] NOT NULL DEFAULT '{}', "contributions" jsonb, "generationRunId" text NOT NULL,
    "generatedAt" timestamp(3) without time zone NOT NULL DEFAULT CURRENT_TIMESTAMP)`);
  await admin.query(`CREATE TABLE ${s}."AuditLog" (
    "id" text PRIMARY KEY, "organizationId" text NOT NULL, "action" text NOT NULL, "detailsJson" jsonb,
    "createdAt" timestamp(3) without time zone NOT NULL DEFAULT CURRENT_TIMESTAMP)`);
  await admin.query(`CREATE TABLE ${s}."ValuationRun" (
    "id" text PRIMARY KEY, "organizationId" text NOT NULL, "asOf" date NOT NULL, "dataThrough" date NOT NULL,
    "published" boolean NOT NULL DEFAULT false, "publishedAt" timestamp(3) without time zone, "sourcesJson" jsonb)`);
  await admin.query(`CREATE TABLE ${s}."PropertyValuation" (
    "id" text PRIMARY KEY, "runId" text NOT NULL, "organizationId" text NOT NULL, "contactId" text NOT NULL,
    "bbl" text, "value" double precision, "low" double precision, "high" double precision, "asOf" date NOT NULL,
    "reason" text, "factsJson" jsonb, "compsJson" jsonb,
    "createdAt" timestamp(3) without time zone NOT NULL DEFAULT CURRENT_TIMESTAMP)`);
}

export async function dropFakeDealflow(admin: pg.Pool, schema: string): Promise<void> {
  await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
}

// Timestamps go in as UTC wall-clock time, as DealFlow stores them (no zone).
const utc = (d: Date) => d.toISOString().replace("T", " ").replace("Z", "");

export class FakeDealflow {
  private seq = 0;
  constructor(private readonly admin: pg.Pool, private readonly schema: string) {}

  private t(name: string) {
    return `"${this.schema}"."${name}"`;
  }

  private id(prefix: string) {
    this.seq += 1;
    return `${prefix}_${this.seq}`;
  }

  async org(slug: string): Promise<string> {
    const id = this.id("dforg");
    await this.admin.query(`INSERT INTO ${this.t("Organization")} ("id", "slug") VALUES ($1, $2)`, [id, slug]);
    return id;
  }

  // A CRM seller in DealFlow: its MojoContact, carrying the CRM lead id (Brief 34).
  async seller(orgId: string, mojoId: string, crmLeadId: string | null): Promise<string> {
    const id = this.id("contact");
    await this.admin.query(
      `INSERT INTO ${this.t("MojoContact")} ("id", "organizationId", "mojoId", "metadata") VALUES ($1, $2, $3, $4::jsonb)`,
      [id, orgId, mojoId, JSON.stringify(crmLeadId ? { source: "crm", crmLeadId } : { source: "crm" })],
    );
    return id;
  }

  // One call list (one generation run): the contacts in rank order.
  async callList(orgId: string, contactIds: string[], generatedAt: Date, runId = this.id("run")): Promise<string> {
    let rank = 0;
    for (const contactId of contactIds) {
      rank += 1;
      await this.admin.query(
        `INSERT INTO ${this.t("CallQueueEntry")} ("id", "organizationId", "contactId", "rank", "priorityScore", "reason",
           "generationRunId", "generatedAt") VALUES ($1, $2, $3, $4, $5, 'Top match', $6, $7::timestamp)`,
        [this.id("cqe"), orgId, contactId, rank, Math.max(1, 90 - rank), runId, utc(generatedAt)],
      );
    }
    return runId;
  }

  async nightly(orgId: string, includeTestBuyers: boolean, createdAt: Date): Promise<void> {
    await this.admin.query(
      `INSERT INTO ${this.t("AuditLog")} ("id", "organizationId", "action", "detailsJson", "createdAt")
       VALUES ($1, $2, 'NIGHTLY_SCORING', $3::jsonb, $4::timestamp)`,
      [this.id("audit"), orgId, JSON.stringify({ includeTestBuyers }), utc(createdAt)],
    );
  }

  // A published (or not) valuation run, and one seller's valuation in it.
  async valuationRun(orgId: string, opts: { asOf: string; publishedAt: Date | null; published?: boolean }): Promise<string> {
    const id = this.id("vrun");
    await this.admin.query(
      `INSERT INTO ${this.t("ValuationRun")} ("id", "organizationId", "asOf", "dataThrough", "published", "publishedAt", "sourcesJson")
       VALUES ($1, $2, $3::date, $3::date - 1, $4, $5::timestamp, $6::jsonb)`,
      [id, orgId, opts.asOf, opts.published ?? true, opts.publishedAt ? utc(opts.publishedAt) : null, JSON.stringify({ plutoVersion: "26v2" })],
    );
    return id;
  }

  async valuation(
    orgId: string,
    runId: string,
    contactId: string,
    v: { asOf: string; value: number | null; low: number | null; high: number | null; reason?: string | null; facts?: unknown },
  ): Promise<void> {
    await this.admin.query(
      `INSERT INTO ${this.t("PropertyValuation")} ("id", "runId", "organizationId", "contactId", "bbl", "value", "low", "high",
         "asOf", "reason", "factsJson", "compsJson") VALUES ($1, $2, $3, $4, '3999990999', $5, $6, $7, $8::date, $9, $10::jsonb, '[]'::jsonb)`,
      [this.id("pv"), runId, orgId, contactId, v.value, v.low, v.high, v.asOf, v.reason ?? null, JSON.stringify(v.facts ?? { units: 2 })],
    );
  }
}
