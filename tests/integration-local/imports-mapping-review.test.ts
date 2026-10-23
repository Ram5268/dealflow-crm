import 'dotenv/config'
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import { NextRequest, type NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { mainIsTestDb } from '../setup/live-guard'
import { putObject } from '@/lib/core-data/importer/storage'
import { POST as proposePOST } from '@/app/api/imports/[id]/proposed-mapping/route'
import { POST as previewPOST } from '@/app/api/imports/[id]/duplicate-preview/route'
import { POST as commitPOST } from '@/app/api/imports/[id]/commit/route'
import { NOTHING_TO_MATCH } from '@/lib/core-data/importer/mapping-edit'
import { AI_UNAVAILABLE_NOTICE, LAST_RUN_NOTICE } from '@/lib/core-data/importer/review-proposal'

// Brief 50 PR 6 (open item 6.6): the review screen's routes on a test
// database. The AI is never called (its key is blanked), and nothing is
// imported for real. Made-up people and 555-01xx numbers only.
//   - no AI answer: the screen still opens, every column on "Don't import";
//   - "already in your CRM" before the commit, for the mapping on screen;
//   - a commit with nothing to match rows on is refused before it starts;
//   - "Back to the import" shows the mapping that was committed.
const enabled = mainIsTestDb() // Brief 41: refuses a live DATABASE_URL_MAIN
const TAG = `TEST_B50_PR6_${Date.now()}`
const col = (column: string, field: string) => ({ column, sampleValues: [], target: { kind: 'standard_field' as const, field }, confidence: 1, reasoning: '' })
const CSV = ['Contact ID,Full Name,Phone', `${TAG}_1,Test Owner One,212-555-0191`, `${TAG}_2,Test Owner Two,212-555-0192`].join('\n')

type Handler = (req: NextRequest, ctx?: { params?: Promise<Record<string, string>> }) => Promise<NextResponse>
async function call(handler: Handler, id: string, body: unknown = {}) {
  const req = new NextRequest(new URL(`/api/imports/${id}`, 'http://localhost'), {
    method: 'POST', body: JSON.stringify(body), headers: { 'content-type': 'application/json' },
  })
  const res = await handler(req, { params: Promise.resolve({ id }) })
  return { status: res.status, body: await res.json() }
}

describe.runIf(enabled)('Brief 50 PR 6: the import review routes', () => {
  let orgId: string
  let userId: string

  async function makeBatch(status = 'pending', mappingJson?: object): Promise<string> {
    const b = await prisma.importBatch.create({
      data: { organizationId: orgId, userId, sourceLabel: TAG, filename: 'review.csv', storageKey: 'pending', status, ...(mappingJson ? { mappingJson } : {}) },
    })
    const key = `imports/${orgId}/${b.id}/review.csv`
    await putObject(key, Buffer.from(CSV))
    await prisma.importBatch.update({ where: { id: b.id }, data: { storageKey: key } })
    return b.id
  }

  beforeAll(async () => {
    orgId = (await prisma.organization.findFirstOrThrow({ where: { slug: 'dealflow-ryan' } })).id
    userId = (await prisma.user.findFirstOrThrow({ where: { organizationId: orgId } })).id
    // Never the real AI from a test (engineering precaution).
    vi.stubEnv('ANTHROPIC_API_KEY', '')
    await prisma.lead.create({
      data: {
        organizationId: orgId, displayName: 'Test Owner One', name: 'Test Owner One', mojoId: `${TAG}_1`, source: TAG,
        contacts: { create: { organizationId: orgId, displayName: 'Test Owner One', phones: { create: { phone: '+12125550191', type: 'mobile', isPrimary: true } } } },
      },
    })
  })

  afterAll(async () => {
    vi.unstubAllEnvs()
    await prisma.lead.deleteMany({ where: { OR: [{ source: TAG }, { mojoId: { startsWith: TAG } }] } })
    await prisma.importBatch.deleteMany({ where: { sourceLabel: TAG } })
  })

  it("with no AI answer the screen still opens: every column on Don't import, with the reason and the custom fields to pick from", async () => {
    const id = await makeBatch()
    const r = await call(proposePOST, id)
    expect(r.status).toBe(200)
    expect(r.body).toMatchObject({ source: 'manual', notice: AI_UNAVAILABLE_NOTICE, totalRowsDetected: 2, headerRow: ['Contact ID', 'Full Name', 'Phone'] })
    expect(r.body.mapping.map((m: { target: { kind: string } }) => m.target.kind)).toEqual(['ignore', 'ignore', 'ignore'])
    expect(r.body.mapping[1].sampleValues).toEqual(['Test Owner One', 'Test Owner Two'])
    expect(Array.isArray(r.body.customFields)).toBe(true)
    expect(await prisma.importBatch.findUniqueOrThrow({ where: { id } })).toMatchObject({ status: 'mapping_review', totalRows: 2 })
  })

  it('"already in your CRM" for the mapping on screen, before anything is imported', async () => {
    const id = await makeBatch('mapping_review')
    const mapping = { mapping: [col('Contact ID', 'Lead.mojoId'), col('Full Name', 'Lead.name'), col('Phone', 'ContactPhone.phone')], likelyDuplicates: [] }
    const r = await call(previewPOST, id, { mapping })
    expect(r.status).toBe(200)
    expect(r.body).toMatchObject({ totalRows: 2, existing: 1, unidentified: 0 })
    expect(r.body.matches).toEqual([
      expect.objectContaining({ row: 2, name: 'Test Owner One', phoneLast4: '0191', leadName: 'Test Owner One', via: 'mojo' }),
    ])
    expect(await prisma.lead.count({ where: { mojoId: `${TAG}_2` } })).toBe(0) // nothing imported
    // A mapping with nothing to match on has nothing to check.
    const none = await call(previewPOST, id, { mapping: { mapping: [{ ...col('Phone', 'ContactPhone.phone'), target: { kind: 'ignore' } }], likelyDuplicates: [] } })
    expect(none).toEqual({ status: 400, body: { error: NOTHING_TO_MATCH } })
  })

  it('a commit with nothing to match rows on is refused before it starts', async () => {
    const id = await makeBatch('mapping_review')
    const allIgnored = { mapping: ['Contact ID', 'Full Name', 'Phone'].map((c) => ({ ...col(c, 'Lead.name'), target: { kind: 'ignore' } })), likelyDuplicates: [] }
    expect(await call(commitPOST, id, { mapping: allIgnored })).toEqual({ status: 400, body: { error: NOTHING_TO_MATCH } })
    expect(await prisma.importBatch.findUniqueOrThrow({ where: { id } })).toMatchObject({ status: 'mapping_review', importedRows: 0 })
  })

  it('the commit runs the screen\'s check with the org\'s custom fields: a new field named like an existing one is that field', async () => {
    const def = await prisma.customFieldDefinition.create({
      data: { organizationId: orgId, objectType: 'lead', name: `${TAG} Beds`, type: 'number', displayOrder: 9999 },
    })
    try {
      const id = await makeBatch('mapping_review')
      const mapping = {
        mapping: [
          col('Contact ID', 'Lead.mojoId'),
          { ...col('Full Name', 'Lead.name'), target: { kind: 'new_custom_field', name: `${TAG} Beds`, type: 'number' } },
          { ...col('Phone', 'Lead.name'), target: { kind: 'existing_custom_field', definitionId: def.id } },
        ],
        likelyDuplicates: [],
      }
      const r = await call(commitPOST, id, { mapping })
      expect(r.status).toBe(400)
      expect(r.body.error).toContain('is chosen for 2 columns')
      expect(await prisma.importBatch.findUniqueOrThrow({ where: { id } })).toMatchObject({ status: 'mapping_review', importedRows: 0 })
    } finally {
      await prisma.customFieldDefinition.delete({ where: { id: def.id } })
    }
  })

  it('"Back to the import" after a stopped run shows the mapping as committed, and keeps showing it on a reload', async () => {
    const committed = { mapping: [col('Contact ID', 'Lead.mojoId'), col('Full Name', 'Contact.name'), col('Phone', 'ContactPhone.phone')], likelyDuplicates: [] }
    const id = await makeBatch('failed', { ...committed, importRun: { id: 'run_old', beatAt: new Date(Date.now() - 3600_000).toISOString() } })
    for (let visit = 0; visit < 2; visit++) {
      const r = await call(proposePOST, id)
      expect(r.status).toBe(200)
      expect(r.body).toMatchObject({ source: 'last-run', notice: LAST_RUN_NOTICE })
      expect(r.body.mapping).toEqual(committed.mapping)
      expect(await prisma.importBatch.findUniqueOrThrow({ where: { id } })).toMatchObject({ status: 'mapping_review' })
    }
  })
})
