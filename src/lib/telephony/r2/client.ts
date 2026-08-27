import { S3Client } from "@aws-sdk/client-s3";

/**
 * Cloudflare R2 is S3-compatible. Lazy singleton built from Doppler-injected
 * creds. Region "auto" + the account-scoped endpoint are R2 conventions.
 */
let _s3: S3Client | undefined;

export function r2Client(): S3Client {
  if (_s3) return _s3;
  const accountId = process.env.R2_ACCOUNT_ID;
  const accessKeyId = process.env.R2_ACCESS_KEY_ID;
  const secretAccessKey = process.env.R2_SECRET_ACCESS_KEY;
  if (!accountId || !accessKeyId || !secretAccessKey) {
    throw new Error("R2_ACCOUNT_ID / R2_ACCESS_KEY_ID / R2_SECRET_ACCESS_KEY required for R2.");
  }
  _s3 = new S3Client({
    region: "auto",
    endpoint: `https://${accountId}.r2.cloudflarestorage.com`,
    credentials: { accessKeyId, secretAccessKey },
  });
  return _s3;
}

export function r2Bucket(): string {
  return process.env.R2_BUCKET_RECORDINGS ?? "dealflow-crm-recordings";
}

/** Minimal S3 surface we depend on — lets tests inject a fake. */
export interface S3Like {
  send: (command: unknown) => Promise<unknown>;
}

export function __resetR2(): void {
  _s3 = undefined;
}
