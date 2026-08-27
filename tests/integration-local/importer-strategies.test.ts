import 'dotenv/config'
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { prisma } from '@/lib/prisma'
import { putObject } from '@/lib/core-data/importer/storage'
import { commitImport } from '@/lib/core-data/importer/commit-worker'
import type { MappingProposal } from '@/lib/core-data/importer/ai-mapping'
import type { EmitResult } from '@/lib/core-data/events/emit'

const enabled = !!process.env.DATABASE_URL_MAIN
let orgId: string
let userId: string

// Mapping with name + address (no mojoId) → exercises name-address dedup, plus
// a nonstandard phone type.
const MAP: MappingProposal = {
  mapping: [
    { column: 'Name', sampleValues: [], target: { kind: 'standard_field', field: 'Contact.name' }, confidence: 1, reasoning: '' },
    { column: 'Addr', sampleValues: [], target: { kind: 'standard_field', field: 'Lead.primaryAddressFull' }, confidence: 1, reasoning: '' },
    { column: 'Phone', sampleValues: [], target: { kind: 'standard_field', field: 'ContactPhone.phone' }, confidence: 1, reasoning: '' },
    { column: 'Type', sampleValues: [], target: { kind: 'standard_field', field: 'ContactPhone.type' }, confidence: 1, reasoning: '' },
  ],
  likelyDuplicates: [],
}

const MOJO_MAP: MappingProposal = {
  mapping: [
    { column: 'Name', sampleValues: [], target: { kind: 'standard_field', field: 'Contact.name' }, confidence: 1, reasoning: '' },
    { column: 'MojoID', sampleValues: [], target: { kind: 'standard_field', field: 'Lead.mojoId' }, confidence: 1, reasoning: '' },
  ],
  likelyDuplicates: [],
}

const emit = async (): Promise<EmitResult> => ({ overflow: false, bytes: 0 })

async function batchFor(csv: string): Promise<string> {
  const b = await prisma.importBatch.create({
    data: { organizationId: orgId, userId, sourceLabel: 'TEST_STRAT', filename: 'x.csv', storageKey: 'p', status: 'pending' },
  })
  const key = `imports/${orgId}/${b.id}/x.csv`
  await putObject(key, Buffer.from(csv))
  await prisma.importBatch.update({ where: { id: b.id }, data: { storageKey: key } })
  return b.id
}

describe.runIf(enabled)('importer duplicate strategies', () => {
  beforeAll(async () => {
    orgId = (await prisma.organization.findFirstOrThrow({ where: { slug: 'dealflow-ryan' } })).id
    userId = (await prisma.user.findFirstOrThrow({ where: { organizationId: orgId } })).id
    await cleanup()
  })
  afterAll(async () => {
    await cleanup()
  })
  async function cleanup() {
    await prisma.lead.deleteMany({ where: { displayName: { startsWith: 'TEST_STRAT' } } })
    await prisma.lead.deleteMany({ where: { mojoId: { startsWith: 'TEST_STRAT_' } } })
  }

  it('name-address dedup merges on RE-import (no phone/mojoId)', async () => {
    // Same lead imported in two separate commits → the second merges (name +
    // address key), not a new lead. (Within a single file, identical no-key rows
    // race the concurrent upsert; cross-commit is the real re-import scenario.)
    const csv = `Name,Addr,Phone,Type\nTEST_STRAT Owner,5 Main St,,`
    await commitImport(await batchFor(csv), 'merge', MAP, 'c', { emit })
    const res = await commitImport(await batchFor(csv), 'merge', MAP, 'c', { emit })
    expect(res.duplicateRows).toBeGreaterThanOrEqual(1)
    const leads = await prisma.lead.count({ where: { displayName: 'TEST_STRAT Owner' } })
    expect(leads).toBe(1)
  })

  it('nonstandard phone type is logged to errorLog', async () => {
    const csv = `Name,Addr,Phone,Type
TEST_STRAT Fax,7 Oak,(212) 555-0711,Fax`
    const batchId = await batchFor(csv)
    await commitImport(batchId, 'merge', MAP, 'c', { emit })
    const batch = await prisma.importBatch.findUniqueOrThrow({ where: { id: batchId } })
    const log = batch.errorLog as Array<{ message: string }>
    expect(log.some((e) => e.message.includes('nonstandard phone type'))).toBe(true)
  })

  it('skip strategy leaves an existing mojoId lead untouched', async () => {
    await commitImport(await batchFor('Name,MojoID\nOrig Name,TEST_STRAT_S1'), 'merge', MOJO_MAP, 'c', { emit })
    const res = await commitImport(
      await batchFor('Name,MojoID\nUpdated Name,TEST_STRAT_S1'),
      'skip',
      MOJO_MAP,
      'c',
      { emit }
    )
    expect(res.skippedRows).toBe(1)
    const lead = await prisma.lead.findFirstOrThrow({ where: { mojoId: 'TEST_STRAT_S1' } })
    expect(lead.displayName).toBe('Orig Name') // unchanged
  })

  it('add-anyway creates a distinct lead even when a name-address match exists', async () => {
    const csv = `Name,Addr,Phone,Type\nTEST_STRAT Dup,9 Elm,,`
    await commitImport(await batchFor(csv), 'merge', MAP, 'c', { emit })
    await commitImport(await batchFor(csv), 'add-anyway', MAP, 'c', { emit })
    const count = await prisma.lead.count({ where: { displayName: 'TEST_STRAT Dup' } })
    expect(count).toBe(2)
  })
})
