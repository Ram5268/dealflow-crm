import { promises as fs } from 'node:fs'
import path from 'node:path'

// ─────────────────────────────────────────────────────────────────────────────
// Object storage for raw import files. Cloudflare R2 in prod (S3-compatible);
// a local-filesystem fallback during isolated build when R2 creds are absent, so
// the importer runs end-to-end against mocks. Same put/get interface either way.
// ─────────────────────────────────────────────────────────────────────────────

const LOCAL_ROOT = path.join(process.cwd(), '.imports')

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

export async function putObject(key: string, body: Buffer): Promise<void> {
  if (r2Configured()) {
    const { PutObjectCommand } = await import('@aws-sdk/client-s3')
    const client = await r2Client()
    await client.send(
      new PutObjectCommand({ Bucket: process.env.R2_BUCKET_IMPORTS!, Key: key, Body: body })
    )
    return
  }
  const full = path.join(LOCAL_ROOT, key)
  await fs.mkdir(path.dirname(full), { recursive: true })
  await fs.writeFile(full, body)
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
  return fs.readFile(path.join(LOCAL_ROOT, key))
}

export function storageBackend(): 'r2' | 'local' {
  return r2Configured() ? 'r2' : 'local'
}
