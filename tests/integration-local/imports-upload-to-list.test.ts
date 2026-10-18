import 'dotenv/config'
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import { createHash } from 'node:crypto'
import { NextRequest, type NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { mainIsTestDb } from '../setup/live-guard'
import { POST as uploadPOST } from '@/app/api/imports/route'
import { POST as destinationPOST } from '@/app/api/imports/destination/route'
import { GET as statusGET } from '@/app/api/imports/[id]/route'
import { POST as scorePOST } from '@/app/api/imports/[id]/score/route'
import { commitImport } from '@/lib/core-data/importer/commit-worker'
import { DESTINATION_MISSING } from '@/lib/core-data/importer/destination'
import type { MappingProposal } from '@/lib/core-data/importer/ai-mapping'
import type { EmitResult } from '@/lib/core-data/events/emit'

// Brief 45 PR F — the upload routes end to end on a test database: the
// destination travels with the upload (refused before anything is stored),
// the commit fills the list, the status read carries the summary, and the
// score route drives DealFlow (a stub here: nothing leaves this process) and
// writes the new people's ranks. Made-up people only.
const enabled = mainIsTestDb() // Brief 41: refuses a live DATABASE_URL_MAIN
const TAG = `TEST_B45F_${Date.now()}`
const emit = async (): Promise<EmitResult> => ({ overflow: false, bytes: 0 })
const col = (column: string, field: string) => ({ column, sampleValues: [], target: { kind: 'standard_field' as const, field }, confidence: 1, reasoning: '' })
const MAPPING = { mapping: [col('MojoID', 'Lead.mojoId'), col('Name', 'Lead.name'), col('Phone', 'ContactPhone.phone')], likelyDuplicates: [] } as unknown as MappingProposal
const CSV = ['MojoID,Name,Phone', `${TAG}_1,Test Owner One,212-555-0151`, `${TAG}_2,Test Owner Two,212-555-0152`, `,Test Owner Three,212-555-0153`].join('\n')

type Handler = (req: NextRequest, ctx?: { params?: Promise<Record<string, string>> }) => Promise<NextResponse>
async function call(handler: Handler, method: string, url: string, opts: { body?: unknown; form?: FormData; params?: Record<string, string> } = {}) {
  const init: ConstructorParameters<typeof NextRequest>[1] = { method }
  if (opts.form) init.body = opts.form
  else if (opts.body !== undefined) Object.assign(init, { body: JSON.stringify(opts.body), headers: { 'content-type': 'application/json' } })
  const res = await handler(new NextRequest(new URL(url, 'http://localhost'), init), opts.params ? { params: Promise.resolve(opts.params) } : undefined)
  return { status: res.status, body: await res.json() }
}
function uploadForm(fields: Record<string, string>): FormData {
  const form = new FormData()
  form.append('file', new File([CSV], 'test-upload.csv', { type: 'text/csv' }))
  form.append('sourceLabel', TAG)
  for (const [k, v] of Object.entries(fields)) form.append(k, v)
  return form
}

describe.runIf(enabled)('Brief 45 PR F: upload into a list, then rank the new people', () => {
  let orgId: string
  let importId: string
  let listId: string
  const listName = `${TAG} Expireds`

  beforeAll(async () => {
    orgId = (await prisma.organization.findFirstOrThrow({ where: { slug: 'dealflow-ryan' } })).id
  })

  afterAll(async () => {
    vi.unstubAllGlobals()
    const batches = await prisma.importBatch.findMany({ where: { sourceLabel: TAG }, select: { id: true } })
    await prisma.lead.deleteMany({ where: { source: { in: batches.map((b) => `import:${b.id}`) } } })
    await prisma.dealFlowDerivedSignal.deleteMany({ where: { mojoId: { startsWith: TAG } } })
    await prisma.importBatch.deleteMany({ where: { sourceLabel: TAG } })
    await prisma.callList.deleteMany({ where: { organizationId: orgId, name: { startsWith: TAG } } })
  })

  it('an upload with a new list: the import and its list are created together', async () => {
    const r = await call(uploadPOST, 'POST', '/api/imports', { form: uploadForm({ newListName: ` ${listName} `, newListFolderId: '' }) })
    expect(r.status).toBe(201)
    importId = r.body.importBatchId
    expect(r.body.targetList).toMatchObject({ name: listName, created: true })
    const batch = await prisma.importBatch.findUniqueOrThrow({ where: { id: importId } })
    listId = batch.targetListId!
    expect(batch).toMatchObject({ status: 'pending', storageKey: `imports/${orgId}/${importId}/test-upload.csv` })
    expect(await prisma.callList.findUniqueOrThrow({ where: { id: listId } })).toMatchObject({ name: listName, folderId: null, source: `upload:${importId}` })
  })

  it('a name already taken is refused before anything is stored, where the choice is made', async () => {
    const before = await prisma.importBatch.count({ where: { sourceLabel: TAG } })
    const r = await call(uploadPOST, 'POST', '/api/imports', { form: uploadForm({ newListName: listName.toUpperCase() }) })
    expect(r).toEqual({ status: 409, body: { error: `A list named "${listName}" is already outside folders.`, field: 'destination' } })
    expect(await prisma.importBatch.count({ where: { sourceLabel: TAG } })).toBe(before)
    expect(await call(uploadPOST, 'POST', '/api/imports', { form: uploadForm({}) })).toMatchObject({ status: 400, body: { error: DESTINATION_MISSING } })
  })

  it('the check before the file is sent says the same, and writes nothing', async () => {
    const lists = await prisma.callList.count({ where: { organizationId: orgId } })
    expect(await call(destinationPOST, 'POST', '/api/imports/destination', { body: { newList: { name: listName, folderId: null } } }))
      .toEqual({ status: 409, body: { error: `A list named "${listName}" is already outside folders.`, field: 'destination' } })
    expect(await call(destinationPOST, 'POST', '/api/imports/destination', { body: { newList: { name: `${TAG} Fresh`, folderId: null } } }))
      .toEqual({ status: 200, body: { ok: true, name: `${TAG} Fresh` } })
    expect(await call(destinationPOST, 'POST', '/api/imports/destination', { body: { listId } })).toEqual({ status: 200, body: { ok: true, name: listName } })
    expect(await call(destinationPOST, 'POST', '/api/imports/destination', { body: {} })).toMatchObject({ status: 400 })
    expect(await prisma.callList.count({ where: { organizationId: orgId } })).toBe(lists)
  })

  it('the commit fills the list; the status read carries the summary', async () => {
    const pending = await call(statusGET, 'GET', `/api/imports/${importId}`, { params: { id: importId } })
    expect(pending.body).toMatchObject({ status: 'pending', targetList: { id: listId, name: listName }, people: null, scoring: null })
    await prisma.importBatch.update({ where: { id: importId }, data: { status: 'mapping_review' } })
    await commitImport(importId, 'merge', MAPPING, 'c', { emit })
    expect(await prisma.listMembership.count({ where: { listId, addedBy: `import:${importId}` } })).toBe(3)
    const done = await call(statusGET, 'GET', `/api/imports/${importId}`, { params: { id: importId } })
    expect(done.body).toMatchObject({
      status: 'completed', totalRows: 3,
      targetList: { id: listId, name: listName, folderName: null, archived: false },
      people: { new: 3, existing: 0, newWithoutMojoId: 1 },
      scoring: { state: 'pending', error: null },
    })
    expect(JSON.stringify(done.body)).not.toMatch(/dealflowScoreTokenHash|mappingJson|sourceBlob/)
  })

  it('the score route asks DealFlow (a stub) and writes the new people’s ranks', async () => {
    const seen: string[][] = []
    vi.stubEnv('DEALFLOW_APP_BASE_URL', 'http://dealflow.test')
    vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
      expect(url).toBe('http://dealflow.test/api/crm/score-import')
      const body = JSON.parse(String(init.body)) as { importId: string; token: string; leadIds: string[] }
      const batch = await prisma.importBatch.findUniqueOrThrow({ where: { id: body.importId } })
      if (batch.dealflowScoreTokenHash !== createHash('sha256').update(body.token).digest('hex')) return Response.json({ error: 'bad_token' }, { status: 403 })
      seen.push(body.leadIds)
      const leads = await prisma.lead.findMany({ where: { id: { in: body.leadIds } }, select: { id: true, mojoId: true } })
      return Response.json({
        importId: body.importId, generatedAt: new Date().toISOString(), includeTestBuyers: false,
        scored: leads.filter((l) => l.mojoId).map((l) => ({
          crmLeadId: l.id, mojoId: l.mojoId, priorityScore: 64, queueReason: 'Match: matchFitLift', primaryMatchId: `m_${l.id}`, primaryMatchFit: 79,
          primaryCaptureStatus: 'EXTERNAL_BOTH', primaryMatchConfidence: 'MEDIUM', matchReason: 'neighborhood', contributions: null, buyers: [], notRankedReason: null,
        })),
        skipped: leads.filter((l) => !l.mojoId).map((l) => ({ crmLeadId: l.id, reason: 'no_mojo_id' })),
      })
    })
    try {
      const r = await call(scorePOST, 'POST', `/api/imports/${importId}/score`, { body: {}, params: { id: importId } })
      expect(r).toMatchObject({ status: 200, body: { done: true, scored: 2, notRanked: 0, skipped: { noMojoId: 1, notCopied: 0, other: 0 }, remaining: 0 } })
      expect(seen).toHaveLength(1)
      expect(seen[0]).toHaveLength(3)
    } finally {
      vi.unstubAllGlobals()
      vi.unstubAllEnvs()
    }
    const leads = await prisma.lead.findMany({ where: { source: `import:${importId}` }, select: { mojoId: true, priorityScore: true } })
    expect(leads.map((l) => l.priorityScore).sort()).toEqual([64, 64, null])
    const status = await call(statusGET, 'GET', `/api/imports/${importId}`, { params: { id: importId } })
    expect(status.body.scoring).toMatchObject({ state: 'done', ranked: 2, notScored: 0 })
    // Bad body: a cursor that isn't an id.
    expect(await call(scorePOST, 'POST', `/api/imports/${importId}/score`, { body: { after: 'x y' }, params: { id: importId } })).toMatchObject({ status: 400 })
  })
})
