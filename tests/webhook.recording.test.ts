import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from "vitest";
import type { PrismaClient } from "@prisma/client";
import { prismaPerf } from "./setup/pg";
import { storeRecording, presignRecording, recordingKey } from "@/lib/telephony/twilio/recording";
import { __resetR2 } from "@/lib/telephony/r2/client";

const ORG = "org_rec";
const P = "CA_rec_";
let prisma: PrismaClient;

function mp3Fetch(ok: boolean): typeof fetch {
  return (async () =>
    ok
      ? new Response(new Uint8Array([1, 2, 3, 4]).buffer, { status: 200 })
      : new Response("no", { status: 404 })) as unknown as typeof fetch;
}

async function seedCall(sid: string) {
  return prisma.call.create({
    data: {
      organizationId: ORG,
      direction: "outbound",
      callMethod: "power",
      localPhone: "+15555550100",
      remotePhone: "+15555550101",
      providerCallSid: sid,
      source: "dealflow-crm",
    },
  });
}

// This suite mutates process.env (R2_* credentials, below). The shared vitest
// config runs with `isolate: false` + `fileParallelism: false`, so EVERY test
// file in suite 1 shares one process and one process.env — anything left set
// here bleeds into every file that runs afterwards.
//
// It did: this file set R2_ACCOUNT_ID / R2_ACCESS_KEY_ID / R2_SECRET_ACCESS_KEY
// and never restored them. Combined with R2_BUCKET_IMPORTS from .env, that made
// storageBackend() report 'r2', failing all 7 tests in
// tests/integration-local/importer-storage.test.ts whenever this file happened
// to run first. vitest orders files by cached duration after the first run, so
// it surfaced as an intermittent ~2-in-6 failure rather than a hard one.
//
// Snapshot/restore the WHOLE env rather than unsetting the specific R2 keys —
// that way the next env var this suite starts touching can't re-arm the same
// class of bug.
let envSnapshot: NodeJS.ProcessEnv;

beforeEach(() => {
  envSnapshot = { ...process.env };
});

afterEach(() => {
  for (const key of Object.keys(process.env)) {
    if (!(key in envSnapshot)) delete process.env[key];
  }
  for (const key of Object.keys(envSnapshot)) {
    process.env[key] = envSnapshot[key];
  }
});

beforeAll(async () => {
  prisma = prismaPerf(4);
  await prisma.$connect();
  await prisma.call.deleteMany({ where: { providerCallSid: { startsWith: P } } });
});
afterAll(async () => {
  await prisma.call.deleteMany({ where: { providerCallSid: { startsWith: P } } });
  await prisma.$disconnect();
});

describe("storeRecording", () => {
  it("downloads the MP3 and PUTs to R2, then sets Call.recordingUrl (the key)", async () => {
    const call = await seedCall(`${P}ok`);
    const send = vi.fn().mockResolvedValue({});
    const r = await storeRecording(
      prisma,
      { callId: call.id, recordingUrl: "https://api.twilio.com/rec/RE1", recordingDurationSec: 12 },
      { s3: { send }, bucket: "bkt", fetchImpl: mp3Fetch(true) },
    );
    expect(r.stored).toBe(true);
    expect(send).toHaveBeenCalledOnce();
    const updated = await prisma.call.findUnique({ where: { id: call.id } });
    expect(updated?.recordingUrl).toBe(recordingKey(call.id));
    expect(updated?.recordingDurationSec).toBe(12);
  });

  it("R2/Twilio failure → stored:false, recordingUrl stays null (call not failed)", async () => {
    const call = await seedCall(`${P}fail`);
    const r = await storeRecording(
      prisma,
      { callId: call.id, recordingUrl: "https://api.twilio.com/rec/RE2" },
      { s3: { send: vi.fn() }, bucket: "bkt", fetchImpl: mp3Fetch(false) },
    );
    expect(r.stored).toBe(false);
    const updated = await prisma.call.findUnique({ where: { id: call.id } });
    expect(updated?.recordingUrl).toBeNull();
  });
});

describe("presignRecording", () => {
  it("produces a presigned URL that references the key (no network)", async () => {
    process.env.R2_ACCOUNT_ID = "acct123";
    process.env.R2_ACCESS_KEY_ID = "ak";
    process.env.R2_SECRET_ACCESS_KEY = "sk";
    __resetR2();
    const url = await presignRecording("recordings/call_x.mp3");
    expect(url).toContain("recordings/call_x.mp3");
    expect(url).toContain("X-Amz-Signature");
    __resetR2();
  });
});
