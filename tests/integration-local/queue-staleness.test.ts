import 'dotenv/config'
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { createHash } from 'node:crypto'
import { prisma } from '@/lib/prisma'
import { getQueue } from '@/lib/core-data/smart-view/queue-service'
import { scoreNextChunk } from '@/lib/core-data/dealflow-score/driver'
import type { BatchCaller } from '@/lib/core-data/query-dsl/compliance-bridge'
import { mainIsTestDb } from '../setup/live-guard'

// Brief 45 PR F (from its independent review): the Queue warns "DealFlow
// signals last synced Xh ago" when the 7:00 sync has stopped. That clock is the
// morning sync's own (rankingTimesSql): signal rows an upload's scoring writes
// mid-day must not reset it and hide a broken morning sync. Made-up data.
const enabled = mainIsTestDb() // Brief 41: refuses a live DATABASE_URL_MAIN
const TAG = `TEST_B45F_STALE_${Date.now()}`
const MIN = 60_000
const caller: BatchCaller = async (body) => body.entries.map((e) => ({ contactPhoneId: e.contactPhoneId, phone: e.phone, callable: true, reasons: [] }))
const sha256 = (s: string) => createHash('sha256').update(s, 'utf8').digest('hex')

describe.runIf(enabled)('the Queue staleness warning ignores rows an upload scored', () => {
  let orgId: string
  let viewId: string
  beforeAll(async () => {
    orgId = (await prisma.organization.findFirstOrThrow({ where: { slug: 'dealflow-ryan' } })).id
    viewId = (await prisma.savedView.create({ data: { organizationId: orgId, name: TAG, type: 'lead',
      sQuery: { type: 'field_condition', field: { kind: 'regular', table: 'lead', column: 'source' }, condition: { type: 'text', mode: 'exact', value: TAG } } as object, sort: [] } })).id
    // The last morning sync was 30 hours ago (it stopped).
    await prisma.dealFlowDerivedSignal.create({ data: { organizationId: orgId, mojoId: `${TAG}_morning`, priorityScore: 50, queueRank: 1,
      syncedAt: new Date(Date.now() - 30 * 60 * MIN), dealflowRawJson: { generatedAt: new Date(Date.now() - 32 * 60 * MIN).toISOString() } } })
  })
  afterAll(async () => {
    const batches = await prisma.importBatch.findMany({ where: { sourceLabel: TAG }, select: { id: true } })
    await prisma.lead.deleteMany({ where: { source: { in: batches.map((b) => `import:${b.id}`) } } })
    await prisma.dealFlowDerivedSignal.deleteMany({ where: { mojoId: { startsWith: TAG } } })
    await prisma.importBatch.deleteMany({ where: { sourceLabel: TAG } })
    await prisma.savedView.deleteMany({ where: { id: viewId } })
  })

  it('the warning shows before an upload, and still shows after the upload is scored', async () => {
    const before = await getQueue(viewId, orgId, { caller })
    expect(before).toMatchObject({ stale: true, staleReason: 'DealFlow signals last synced 30h ago' })

    const b = await prisma.importBatch.create({ data: { organizationId: orgId, userId: 'u', sourceLabel: TAG, filename: 'x.csv', storageKey: 'none',
      status: 'completed', createdAt: new Date(Date.now() - 12 * MIN), completedAt: new Date(Date.now() - 5 * MIN) } })
    const lead = await prisma.lead.create({ data: { organizationId: orgId, displayName: 'Test Owner Stale', mojoId: `${TAG}_new`, source: `import:${b.id}`, createdAt: new Date(Date.now() - 10 * MIN) } })
    const fetch = (async (_u: string | URL, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { importId: string; token: string; leadIds: string[] }
      const batch = await prisma.importBatch.findUniqueOrThrow({ where: { id: body.importId } })
      if (batch.dealflowScoreTokenHash !== sha256(body.token)) return Response.json({ error: 'bad_token' }, { status: 403 })
      return Response.json({ importId: body.importId, generatedAt: new Date().toISOString(), includeTestBuyers: false, skipped: [],
        scored: [{ crmLeadId: lead.id, mojoId: `${TAG}_new`, priorityScore: 60, queueReason: 'r', primaryMatchId: 'm1', primaryMatchFit: 70, primaryCaptureStatus: null,
          primaryMatchConfidence: null, matchReason: 'n', contributions: null, buyers: [], notRankedReason: null }] })
    }) as typeof globalThis.fetch
    expect(await scoreNextChunk(orgId, b.id, null, { fetch, baseUrl: 'http://dealflow.test' })).toMatchObject({ done: true, scored: 1 })

    const after = await getQueue(viewId, orgId, { caller })
    expect(after).toMatchObject({ stale: true, staleReason: 'DealFlow signals last synced 30h ago' })
  })
})
