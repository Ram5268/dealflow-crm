import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
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
