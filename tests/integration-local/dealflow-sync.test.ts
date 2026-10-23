import 'dotenv/config'
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { prisma } from '@/lib/prisma'
import { runDealflowSync } from '@/lib/core-data/dealflow-sync/run'
import { fetchDealflowBatch, buildSignals } from '@/lib/core-data/dealflow-sync/sync'
import { closeDealflowRoPool, dealflowRoConfigured } from '@/lib/core-data/dealflow-sync/ro-client'
import { mainIsTestDb } from '../setup/live-guard'

const enabled = mainIsTestDb() // Brief 41: refuses a live DATABASE_URL_MAIN
const roEnabled = dealflowRoConfigured() // Brief 41.2: only the RO client reads its setting

let orgId: string

describe.runIf(enabled)('dealflow sync', () => {
  beforeAll(async () => {
    orgId = (await prisma.organization.findFirstOrThrow({ where: { slug: 'dealflow-ryan' } })).id
    // A CRM lead whose mojoId matches the stub signal → should get promoted.
    await prisma.lead.deleteMany({ where: { mojoId: 'mojo_stub_1' } })
    await prisma.dealFlowDerivedSignal.deleteMany({ where: { mojoId: 'mojo_stub_1' } })
    await prisma.lead.create({
      data: { organizationId: orgId, displayName: 'Stub Lead', mojoId: 'mojo_stub_1' },
    })
  })

  afterAll(async () => {
    await prisma.lead.deleteMany({ where: { mojoId: 'mojo_stub_1' } })
    await prisma.dealFlowDerivedSignal.deleteMany({ where: { mojoId: 'mojo_stub_1' } })
    await closeDealflowRoPool()
  })

  it('stub-mode sync upserts a signal and promotes the matching lead', async () => {
    process.env.DEALFLOW_SYNC_STUB = '1'
    try {
      const res = await runDealflowSync(orgId)
      expect(res.count).toBeGreaterThanOrEqual(1)
      expect(res.leadsPromoted).toBeGreaterThanOrEqual(1)

      const signal = await prisma.dealFlowDerivedSignal.findUnique({ where: { mojoId: 'mojo_stub_1' } })
      expect(signal?.primaryCaptureStatus).toBe('OWN_BUYER_ONLY')

      const lead = await prisma.lead.findFirst({ where: { mojoId: 'mojo_stub_1' } })
      expect(lead?.priorityScore).toBe(93)
      expect(lead?.topMatchFit).toBe(94)
      expect(lead?.captureStatus).toBe('OWN_BUYER_ONLY')
      expect(lead?.dealflowSignalSyncedAt).toBeTruthy()
    } finally {
      process.env.DEALFLOW_SYNC_STUB = '0'
    }
  })

  it('stub-mode re-run is idempotent (no duplicate signal rows)', async () => {
    process.env.DEALFLOW_SYNC_STUB = '1'
    try {
      await runDealflowSync(orgId)
      await runDealflowSync(orgId)
      const count = await prisma.dealFlowDerivedSignal.count({ where: { mojoId: 'mojo_stub_1' } })
      expect(count).toBe(1)
    } finally {
      process.env.DEALFLOW_SYNC_STUB = '0'
    }
  })
})

// Real read against DealFlow's live railway DB — validates the adapted query
// compiles against the ACTUAL schema and returns joined rows with mojoIds.
describe.runIf(roEnabled)('dealflow RO live read (SELECT-only)', () => {
  afterAll(async () => {
    await closeDealflowRoPool()
  })
  it('reads the latest CallQueueEntry batch and builds signals', async () => {
    delete process.env.DEALFLOW_SYNC_STUB
    const batch = await fetchDealflowBatch('dealflow-ryan') // Brief 50 (PR 11): Ryan's organization only
    expect(Array.isArray(batch.rows)).toBe(true)
    // Brief 37: the whole ranked list; each row should have a mojoId to be usable.
    const signals = buildSignals(batch)
    expect(signals.length).toBeGreaterThan(0)
    expect(signals[0].mojoId).toBeTruthy()
  })
})
