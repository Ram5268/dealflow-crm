import { prisma } from '@/lib/prisma'

// ─────────────────────────────────────────────────────────────────────────────
// Object storage for raw import files. Cloudflare R2 (S3-compatible) when its
// env vars are set; otherwise the bytes live in a Postgres BYTEA column on the
// owning ImportBatch. Same put/get interface either way.
//
// The previous fallback wrote to `.imports/` under process.cwd(). On Vercel the
// serverless filesystem is read-only, so every upload died with
// `ENOENT: mkdir '/var/task/.imports'`. Postgres is already a hard dependency of
// the app, so it costs no new vendor and works identically in dev and prod.
// ─────────────────────────────────────────────────────────────────────────────

function r2Configured(): boolean {
  return !!(
    process.env.R2_ACCOUNT_ID &&
    process.env.R2_ACCESS_KEY_ID &&
    process.env.R2_SECRET_ACCESS_KEY &&
    process.env.R2_BUCKET_IMPORTS
  )
}

async function r2Client() {
  const { S3Client } = await import('@aws-sdk/client-s3')
  return new S3Client({
    region: 'auto',
    endpoint: `https://${process.env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
    credentials: {
      accessKeyId: process.env.R2_ACCESS_KEY_ID!,
      secretAccessKey: process.env.R2_SECRET_ACCESS_KEY!,
    },
  })
}

// CONTRACT with POST /api/imports: keys are `imports/<orgId>/<batchId>/<filename>`.
// The Postgres branch stores bytes on the ImportBatch row named by segment 2, so
// any change to the key shape must change both this function and route.ts:35.
// Index-based (not count-based) so a filename containing "/" can't shift it.
function batchIdFromKey(key: string): string {
  const id = key.split('/')[2]
  if (!id) throw new Error(`storage: cannot derive ImportBatch id from key "${key}"`)
  return id
}

export async function putObject(key: string, body: Buffer): Promise<void> {
  if (r2Configured()) {
    const { PutObjectCommand } = await import('@aws-sdk/client-s3')
    const client = await r2Client()
    await client.send(
      new PutObjectCommand({ Bucket: process.env.R2_BUCKET_IMPORTS!, Key: key, Body: body })
    )
    return
  }
  await prisma.importBatch.update({
    where: { id: batchIdFromKey(key) },
    data: { sourceBlob: body },
  })
}

export async function getObject(key: string): Promise<Buffer> {
  if (r2Configured()) {
    const { GetObjectCommand } = await import('@aws-sdk/client-s3')
    const client = await r2Client()
    const res = await client.send(
      new GetObjectCommand({ Bucket: process.env.R2_BUCKET_IMPORTS!, Key: key })
    )
    const bytes = await res.Body!.transformToByteArray()
    return Buffer.from(bytes)
  }
  const row = await prisma.importBatch.findUnique({
    where: { id: batchIdFromKey(key) },
    select: { sourceBlob: true },
  })
  if (!row?.sourceBlob) {
    // Either the batch is gone or its blob was swept (see the sweep in
    // POST /api/imports). Both are unrecoverable here — the caller needs the
    // raw file, and there is no second copy to fall back to.
    throw new Error(`storage: no stored bytes for key "${key}"`)
  }
  return Buffer.from(row.sourceBlob)
}

export function storageBackend(): 'r2' | 'postgres' {
  return r2Configured() ? 'r2' : 'postgres'
}
