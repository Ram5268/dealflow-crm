import type { PrismaClient } from "@prisma/client";
import { PutObjectCommand, GetObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { S3Client } from "@aws-sdk/client-s3";
import { r2Client, r2Bucket, type S3Like } from "../r2/client";
import { logger } from "@/lib/logger";

export interface StoreRecordingArgs {
  callId: string;
  recordingUrl: string; // Twilio RecordingUrl (without .mp3)
  recordingDurationSec?: number;
}

export interface StoreRecordingDeps {
  s3?: S3Like;
  bucket?: string;
  fetchImpl?: typeof fetch;
}

export function recordingKey(callId: string): string {
  return `recordings/${callId}.mp3`;
}

/**
 * Fetch the MP3 from Twilio (basic-auth) and PUT it to R2 at
 * `recordings/<callId>.mp3`, then set `Call.recordingUrl` (the R2 KEY, never the
 * public URL). On ANY failure: Sentry-log, retain the Twilio URL for a later
 * retry, and DO NOT fail the call (returns { stored:false }).
 */
export async function storeRecording(
  prisma: PrismaClient,
  args: StoreRecordingArgs,
  deps: StoreRecordingDeps = {},
): Promise<{ stored: boolean }> {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const bucket = deps.bucket ?? r2Bucket();
  const key = recordingKey(args.callId);
  try {
    const sid = process.env.TWILIO_ACCOUNT_SID ?? "";
    const token = process.env.TWILIO_AUTH_TOKEN ?? "";
    const auth = Buffer.from(`${sid}:${token}`).toString("base64");
    const res = await fetchImpl(`${args.recordingUrl}.mp3`, {
      headers: { authorization: `Basic ${auth}` },
    });
    if (!res.ok) throw new Error(`twilio recording fetch failed: ${res.status}`);
    const body = new Uint8Array(await res.arrayBuffer());

    const s3 = deps.s3 ?? (r2Client() as unknown as S3Like);
    await s3.send(new PutObjectCommand({ Bucket: bucket, Key: key, Body: body, ContentType: "audio/mpeg" }));

    await prisma.call.updateMany({
      where: { id: args.callId },
      data: { recordingUrl: key, recordingDurationSec: args.recordingDurationSec ?? null },
    });
    return { stored: true };
  } catch (err) {
    logger.error(
      { err, callId: args.callId },
      "R2 recording store failed — retaining Twilio URL for nightly retry; not failing the call",
    );
    return { stored: false };
  }
}

/** Presign a GET for the R2 recording key. TTL 300s. Never exposed directly. */
export async function presignRecording(key: string, s3?: S3Like): Promise<string> {
  const client = (s3 ?? r2Client()) as unknown as S3Client;
  return getSignedUrl(client, new GetObjectCommand({ Bucket: r2Bucket(), Key: key }), {
    expiresIn: 300,
  });
}
