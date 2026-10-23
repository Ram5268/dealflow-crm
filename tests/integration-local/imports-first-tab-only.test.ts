import 'dotenv/config'
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import { NextRequest, type NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { mainIsTestDb } from '../setup/live-guard'
import { putObject } from '@/lib/core-data/importer/storage'
import { commitImport } from '@/lib/core-data/importer/commit-worker'
import type { MappingProposal } from '@/lib/core-data/importer/ai-mapping'
import type { EmitResult } from '@/lib/core-data/events/emit'
import { POST as proposePOST } from '@/app/api/imports/[id]/proposed-mapping/route'
import { POST as previewPOST } from '@/app/api/imports/[id]/duplicate-preview/route'
import { workbookBuffer, type FakeSheet } from '../unit/helpers/fake-spreadsheets'

// Brief 50 PR 20 (Revision 2, the planner's review of 2026-10-23): an Excel
// import reads the first visible tab only, because an import can't be undone.
// On a test database: a workbook whose second tab ("DNC") has the same columns
// as the first. The review screen is told which tabs weren't imported, the
// "already in your CRM" check and the commit see only the first tab, and
// nobody on the DNC tab becomes a lead. The AI is never called (its key is
// blanked). Made-up people and 555-01xx numbers only.
const enabled = mainIsTestDb() // Brief 41: refuses a live DATABASE_URL_MAIN
const TAG = `TEST_B50_PR20_${Date.now()}`
const HEAD = ['Contact ID', 'Full Name', 'Phone']
const FIRST: FakeSheet = {
  name: 'Brooklyn',
  rows: [HEAD, [`${TAG}_1`, 'Test Owner One', '212-555-0181'], [`${TAG}_2`, 'Test Owner Two', '212-555-0182']],
}
const DNC: FakeSheet = { name: 'DNC', rows: [HEAD, [`${TAG}_3`, 'Test Owner Three', '212-555-0183']] }
// A stale copy of the first tab: same person, an older name.
const BACKUP: FakeSheet = { name: 'Sheet1 (2)', rows: [HEAD, [`${TAG}_1`, 'Test Owner One Old', '212-555-0181']] }
const LOOKUPS: FakeSheet = { name: 'Lookups', rows: [['Code', 'Meaning'], ['A', 'Active']], hidden: true }

const col = (column: string, field: string) => ({ column, sampleValues: [], target: { kind: 'standard_field' as const, field }, confidence: 1, reasoning: '' })
const MAPPING: MappingProposal = {
  mapping: [col('Contact ID', 'Lead.mojoId'), col('Full Name', 'Lead.name'), col('Phone', 'ContactPhone.phone')],
  likelyDuplicates: [],
}

type Handler = (req: NextRequest, ctx?: { params?: Promise<Record<string, string>> }) => Promise<NextResponse>
async function call(handler: Handler, id: string, body: unknown = {}) {
  const req = new NextRequest(new URL(`/api/imports/${id}`, 'http://localhost'), {
    method: 'POST', body: JSON.stringify(body), headers: { 'content-type': 'application/json' },
  })
  const res = await handler(req, { params: Promise.resolve({ id }) })
  return { status: res.status, body: await res.json() }
}

describe.runIf(enabled)('Brief 50 PR 20: Excel imports read the first tab only', () => {
  let orgId: string
  let userId: string

  async function makeBatch(sheets: FakeSheet[]): Promise<string> {
    const b = await prisma.importBatch.create({
      data: { organizationId: orgId, userId, sourceLabel: TAG, filename: 'owners.xlsx', storageKey: 'pending', status: 'pending' },
    })
    const key = `imports/${orgId}/${b.id}/owners.xlsx`
    await putObject(key, workbookBuffer(sheets, 'xlsx'))
    await prisma.importBatch.update({ where: { id: b.id }, data: { storageKey: key } })
    return b.id
  }

  beforeAll(async () => {
    orgId = (await prisma.organization.findFirstOrThrow({ where: { slug: 'dealflow-ryan' } })).id
    userId = (await prisma.user.findFirstOrThrow({ where: { organizationId: orgId } })).id
    vi.stubEnv('ANTHROPIC_API_KEY', '') // never the real AI from a test (engineering precaution)
  })

  afterAll(async () => {
    vi.unstubAllEnvs()
    await prisma.lead.deleteMany({ where: { mojoId: { startsWith: TAG } } })
    await prisma.importBatch.deleteMany({ where: { sourceLabel: TAG } })
  })

  it('the review screen gets the first tab\'s rows and the names of the tabs not imported', async () => {
    const id = await makeBatch([FIRST, DNC, LOOKUPS])
    const r = await call(proposePOST, id)
    expect(r.status).toBe(200)
    expect(r.body).toMatchObject({ totalRowsDetected: 2, headerRow: HEAD })
    expect(r.body.tabs).toEqual({
      read: 'Brooklyn',
      notImported: [{ name: 'DNC', hidden: false }, { name: 'Lookups', hidden: true }],
      more: 0,
      rowLimit: null,
    })
    expect(await prisma.importBatch.findUniqueOrThrow({ where: { id } })).toMatchObject({ totalRows: 2 })

    const preview = await call(previewPOST, id, { mapping: MAPPING })
    expect(preview.status).toBe(200)
    expect(preview.body).toMatchObject({ totalRows: 2 })
  })

  it('a CSV has no tab line', async () => {
    const b = await prisma.importBatch.create({
      data: { organizationId: orgId, userId, sourceLabel: TAG, filename: 'owners.csv', storageKey: 'pending', status: 'pending' },
    })
    const key = `imports/${orgId}/${b.id}/owners.csv`
    await putObject(key, Buffer.from(`Contact ID,Full Name,Phone\n${TAG}_9,Test Owner Nine,212-555-0189\n`))
    await prisma.importBatch.update({ where: { id: b.id }, data: { storageKey: key } })
    const r = await call(proposePOST, b.id)
    expect(r.status).toBe(200)
    expect(r.body.tabs).toBeNull()
  })

  it('the commit imports the first tab only: nobody on the DNC tab becomes a lead, and the backup tab overwrites no one', async () => {
    const id = await makeBatch([FIRST, DNC, BACKUP])
    const emit = async (): Promise<EmitResult> => ({ overflow: false, bytes: 0 })
    const res = await commitImport(id, 'merge', MAPPING, 'cid-b50-pr20', { emit })
    expect(res).toMatchObject({ totalRows: 2, importedRows: 2 })
    const leads = await prisma.lead.findMany({ where: { mojoId: { startsWith: TAG } }, select: { mojoId: true, name: true }, orderBy: { mojoId: 'asc' } })
    expect(leads).toEqual([
      { mojoId: `${TAG}_1`, name: 'Test Owner One' },
      { mojoId: `${TAG}_2`, name: 'Test Owner Two' },
    ])
  })
})
