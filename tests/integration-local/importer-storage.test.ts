import 'dotenv/config'
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest'
import { prisma } from '@/lib/prisma'
import { putObject, getObject, storageBackend } from '@/lib/core-data/importer/storage'

// Storage backend coverage for the Postgres BYTEA path that replaced the
// local-filesystem fallback (which died on Vercel's read-only /var/task).
//
// Deliberately DB-backed rather than vi.mock('@/lib/prisma'): the shared vitest
// config runs with `isolate: false` on ONE Prisma pool, and its own header note
// says per-file prisma mocks bleed across files there. A live round-trip also
// proves what a mock cannot — that Prisma actually marshals Buffer -> BYTEA ->
// Buffer without corrupting bytes.
const enabled = !!process.env.DATABASE_URL_MAIN

let orgId: string
let userId: string
const createdBatchIds: string[] = []

async function makeBatch(): Promise<string> {
  const batch = await prisma.importBatch.create({
    data: {
      organizationId: orgId,
      userId,
      sourceLabel: 'TEST_STORAGE',
      filename: 's.csv',
      storageKey: 'pending',
      status: 'pending',
    },
  })
  createdBatchIds.push(batch.id)
  return batch.id
}

const keyFor = (batchId: string, filename = 's.csv') => `imports/${orgId}/${batchId}/${filename}`

describe.runIf(enabled)('importer storage (postgres backend)', () => {
  beforeAll(async () => {
    const org = await prisma.organization.findFirstOrThrow({ where: { slug: 'dealflow-ryan' } })
    orgId = org.id
    userId = (await prisma.user.findFirstOrThrow({ where: { organizationId: orgId } })).id
  })

  afterAll(async () => {
    await prisma.importBatch.deleteMany({ where: { id: { in: createdBatchIds } } })
  })

  // Belt-and-braces against the shared-process env bleed (`isolate: false`).
  // Every case here asserts the POSTGRES backend, which only holds while R2 is
  // unconfigured — and .env legitimately ships R2_BUCKET_IMPORTS, so a single
  // leaked credential from another file is enough to flip storageBackend() to
  // 'r2'. Clear the four keys per test, then restore, so this file neither
  // depends on ambient env nor leaks its own clearing to later files.
  const R2_KEYS = [
    'R2_ACCOUNT_ID',
    'R2_ACCESS_KEY_ID',
    'R2_SECRET_ACCESS_KEY',
    'R2_BUCKET_IMPORTS',
  ] as const
  let r2Saved: Record<string, string | undefined> = {}

  beforeEach(() => {
    r2Saved = Object.fromEntries(R2_KEYS.map((k) => [k, process.env[k]]))
    for (const k of R2_KEYS) delete process.env[k]
  })

  afterEach(() => {
    for (const [k, v] of Object.entries(r2Saved)) {
      if (v === undefined) delete process.env[k]
      else process.env[k] = v
    }
  })

  it('defaults to the postgres backend when R2 is unconfigured', () => {
    expect(storageBackend()).toBe('postgres')
  })

  it('reports the r2 backend when all four R2 vars are set', () => {
    const saved = {
      R2_ACCOUNT_ID: process.env.R2_ACCOUNT_ID,
      R2_ACCESS_KEY_ID: process.env.R2_ACCESS_KEY_ID,
      R2_SECRET_ACCESS_KEY: process.env.R2_SECRET_ACCESS_KEY,
      R2_BUCKET_IMPORTS: process.env.R2_BUCKET_IMPORTS,
    }
    try {
      process.env.R2_ACCOUNT_ID = 'acct'
      process.env.R2_ACCESS_KEY_ID = 'akid'
      process.env.R2_SECRET_ACCESS_KEY = 'secret'
      process.env.R2_BUCKET_IMPORTS = 'bucket'
      expect(storageBackend()).toBe('r2')
    } finally {
      for (const [k, v] of Object.entries(saved)) {
        if (v === undefined) delete process.env[k]
        else process.env[k] = v
      }
    }
    expect(storageBackend()).toBe('postgres')
  })

  it('round-trips bytes through the ImportBatch row', async () => {
    const batchId = await makeBatch()
    // Non-UTF8 bytes on purpose: a text-coerced column would mangle these.
    const body = Buffer.from([0x00, 0xff, 0x41, 0x0a, 0xc3, 0x28, 0x7f])
    await putObject(keyFor(batchId), body)
    expect(await getObject(keyFor(batchId))).toEqual(body)
  })

  it('stores the bytes on the batch named by the key, not the newest batch', async () => {
    const first = await makeBatch()
    const second = await makeBatch()
    await putObject(keyFor(first), Buffer.from('first'))
    await putObject(keyFor(second), Buffer.from('second'))
    expect((await getObject(keyFor(first))).toString()).toBe('first')
    expect((await getObject(keyFor(second))).toString()).toBe('second')
  })

  it('tolerates a filename containing a slash (key parsing is index-based)', async () => {
    const batchId = await makeBatch()
    await putObject(keyFor(batchId, 'nested/name.csv'), Buffer.from('slashed'))
    expect((await getObject(keyFor(batchId, 'nested/name.csv'))).toString()).toBe('slashed')
  })

  it('throws once the blob has been swept, rather than returning empty bytes', async () => {
    const batchId = await makeBatch()
    await putObject(keyFor(batchId), Buffer.from('doomed'))
    await prisma.importBatch.update({ where: { id: batchId }, data: { sourceBlob: null } })
    await expect(getObject(keyFor(batchId))).rejects.toThrow(/no stored bytes/)
  })

  it('rejects a key it cannot derive a batch id from', async () => {
    await expect(putObject('imports', Buffer.from('x'))).rejects.toThrow(/cannot derive/)
    await expect(getObject('imports')).rejects.toThrow(/cannot derive/)
  })
})
