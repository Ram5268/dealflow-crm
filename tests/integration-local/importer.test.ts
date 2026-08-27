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

const MAPPING: MappingProposal = {
  mapping: [
    { column: 'Name', sampleValues: [], target: { kind: 'standard_field', field: 'Contact.name' }, confidence: 1, reasoning: '' },
    { column: 'MojoID', sampleValues: [], target: { kind: 'standard_field', field: 'Lead.mojoId' }, confidence: 1, reasoning: '' },
    { column: 'Phone', sampleValues: [], target: { kind: 'standard_field', field: 'ContactPhone.phone' }, confidence: 1, reasoning: '' },
    { column: 'Type', sampleValues: [], target: { kind: 'standard_field', field: 'ContactPhone.type' }, confidence: 1, reasoning: '' },
    { column: 'Est Value', sampleValues: [], target: { kind: 'new_custom_field', name: 'TEST_IMP Est Value', type: 'number' }, confidence: 1, reasoning: '' },
  ],
  likelyDuplicates: [],
}

async function makeBatch(csv: string, filename = 'imp.csv'): Promise<string> {
  const batch = await prisma.importBatch.create({
    data: { organizationId: orgId, userId, sourceLabel: 'TEST_IMP', filename, storageKey: 'pending', status: 'pending' },
  })
  const key = `imports/${orgId}/${batch.id}/${filename}`
  await putObject(key, Buffer.from(csv))
  await prisma.importBatch.update({ where: { id: batch.id }, data: { storageKey: key } })
  return batch.id
}

function captureEmit() {
  const payloads: Array<Record<string, unknown>> = []
  const emit = async (_channel: string, payload: Record<string, unknown>): Promise<EmitResult> => {
    payloads.push(payload)
    return { overflow: false, bytes: 0 }
  }
  return { emit, payloads }
}

describe.runIf(enabled)('importer commit', () => {
  beforeAll(async () => {
    const org = await prisma.organization.findFirstOrThrow({ where: { slug: 'dealflow-ryan' } })
    orgId = org.id
    userId = (await prisma.user.findFirstOrThrow({ where: { organizationId: orgId } })).id
    // Clean prior test artifacts.
    await prisma.lead.deleteMany({ where: { source: { startsWith: 'import:' }, mojoId: { startsWith: 'TEST_IMP_' } } })
    await prisma.customFieldDefinition.deleteMany({ where: { organizationId: orgId, name: 'TEST_IMP Est Value' } })
  })

  afterAll(async () => {
    await prisma.lead.deleteMany({ where: { mojoId: { startsWith: 'TEST_IMP_' } } })
    await prisma.customFieldDefinition.deleteMany({ where: { organizationId: orgId, name: 'TEST_IMP Est Value' } })
  })

  it('every upserted lead has source=import:<batchId>; emit carries no eventName; custom field created', async () => {
    const csv = `Name,MojoID,Phone,Type,Est Value
Acme LLC,TEST_IMP_1,(212) 555-0134,Cell,$2500000
Beta Corp,TEST_IMP_2,212-555-0200,Work,$1800000`
    const batchId = await makeBatch(csv)
    const { emit, payloads } = captureEmit()

    const res = await commitImport(batchId, 'merge', MAPPING, 'cid-imp', { emit })
    expect(res.totalRows).toBe(2)
    expect(res.importedRows).toBe(2)

    const leads = await prisma.lead.findMany({ where: { mojoId: { in: ['TEST_IMP_1', 'TEST_IMP_2'] } } })
    expect(leads).toHaveLength(2)
    for (const l of leads) expect(l.source).toBe(`import:${batchId}`)

    // Emit shape: one per row, no eventName/type discriminant.
    expect(payloads).toHaveLength(2)
    for (const p of payloads) {
      expect(p).not.toHaveProperty('eventName')
      expect(p).not.toHaveProperty('type')
      expect(p.importBatchId).toBe(batchId)
      expect(p.leadId).toBeTruthy()
    }

    // Custom field definition + value created.
    const def = await prisma.customFieldDefinition.findFirst({ where: { organizationId: orgId, name: 'TEST_IMP Est Value' } })
    expect(def?.type).toBe('number')
    const val = await prisma.customFieldValue.findFirst({ where: { definitionId: def!.id, objectId: leads[0].id } })
    expect(val?.valueNumber).toBeGreaterThan(0)

    // Phone normalized to E.164.
    const contact = await prisma.contact.findFirst({ where: { leadId: leads[0].id }, include: { phones: true } })
    expect(contact?.phones[0].phone).toMatch(/^\+1212555/)
  })

  it('re-commit of the same CSV is idempotent (mojoId dedup — no new leads)', async () => {
    const csv = `Name,MojoID,Phone,Type,Est Value
Gamma LLC,TEST_IMP_3,(212) 555-0300,Cell,$900000`
    const batchId = await makeBatch(csv)
    const { emit } = captureEmit()

    await commitImport(batchId, 'merge', MAPPING, 'cid-imp', { emit })
    const afterFirst = await prisma.lead.count({ where: { mojoId: 'TEST_IMP_3' } })
    await commitImport(batchId, 'merge', MAPPING, 'cid-imp', { emit })
    const afterSecond = await prisma.lead.count({ where: { mojoId: 'TEST_IMP_3' } })
    expect(afterFirst).toBe(1)
    expect(afterSecond).toBe(1)

    const phones = await prisma.contactPhone.count({
      where: { phone: '+12125550300', contact: { organizationId: orgId } },
    })
    expect(phones).toBe(1) // no duplicate phone rows on re-commit
  })

  it('1000-row CSV imports in <60s with correct counters', async () => {
    const lines = ['Name,MojoID,Phone,Type,Est Value']
    for (let i = 0; i < 1000; i++) {
      const num = (5551000 + i).toString().slice(-7)
      lines.push(`Owner ${i},TEST_IMP_K${i},+1212${num},Cell,${100000 + i}`)
    }
    const batchId = await makeBatch(lines.join('\n'), 'imp1k.csv')
    const { emit } = captureEmit()
    const t0 = Date.now()
    const res = await commitImport(batchId, 'merge', MAPPING, 'cid-imp', { emit })
    const elapsed = Date.now() - t0
    expect(res.totalRows).toBe(1000)
    expect(res.importedRows).toBe(1000)
    expect(elapsed).toBeLessThan(60_000)
    // Cleanup 1k
    await prisma.lead.deleteMany({ where: { mojoId: { startsWith: 'TEST_IMP_K' } } })
  }, 90_000)
})
