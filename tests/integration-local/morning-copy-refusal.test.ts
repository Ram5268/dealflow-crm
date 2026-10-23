import 'dotenv/config'
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import type pg from 'pg'
import { NextRequest } from 'next/server'
import { renderToStaticMarkup } from 'react-dom/server'
import { prisma } from '@/lib/prisma'
import { resetEnvCache } from '@/lib/compliance/env'
import { closeDealflowRoPool } from '@/lib/core-data/dealflow-sync/ro-client'
import { lastScheduledCopy } from '@/lib/core-data/dealflow-sync/nightly-notice'
import { GET as morningCopy } from '@/app/api/cron/dealflow-signal-sync/route'
import { MorningCopyNotice } from '@/components/NightlyNoticeBanner'
import { mainIsTestDb } from '../setup/live-guard'
import { makePerfPool, perfConnectionString } from '../setup/pg'
import { makeOrg, dropOrg, makeLead } from '../setup/b45'
import { createFakeDealflow, dropFakeDealflow, fakeDealflowUrl, FakeDealflow } from '../helpers/fake-dealflow'

// Brief 50 (PR 19), the planner's review (Revision 2): a refused morning copy
// is no longer invisible.
//   • The cron route answers a refusal with 409 (non-2xx), so Vercel's cron
//     log shows a failed run; an empty or stale DealFlow list still answers
//     200 ok:false, and the job-key check is unchanged
//     (tests/unit/cron-auth.test.ts).
//   • The Queue's line [Ryan's no-babysitting rule, 2026-10-18: checks show up
//     in the product], rendered by the component the page shows in both
//     modes, on the real clock.
// The CRM side is the test MAIN database (the route reads the seeded
// "dealflow-ryan" organization; the line uses an organization of its own),
// the DealFlow side a DealFlow-shaped scratch schema in the perf test
// database, read through the real read-only client. Made-up rows only.
const enabled = mainIsTestDb() // Brief 41: refuses a live DATABASE_URL_MAIN
const TAG = `b50cr_${Date.now()}`
const SCHEMA = `b50_fake_dealflow_cr_${Date.now()}`
const SECRET = 'test-cron-secret-b50-pr19'
const HOUR = 3_600_000

describe.runIf(enabled)('a refused morning copy shows up', () => {
  let admin: pg.Pool
  let fake: FakeDealflow
  let savedEnv: Record<string, string | undefined> = {}
  const orgs: string[] = []

  beforeAll(async () => {
    savedEnv = { ...process.env }
    delete process.env.DEALFLOW_SYNC_STUB
    process.env.CRON_SECRET = SECRET
    resetEnvCache()
    await closeDealflowRoPool()
    admin = makePerfPool(2)
    await createFakeDealflow(admin, SCHEMA)
    fake = new FakeDealflow(admin, SCHEMA)
    process.env.DATABASE_URL_DEALFLOW_RO = fakeDealflowUrl(perfConnectionString(), SCHEMA)
  })

  afterAll(async () => {
    await closeDealflowRoPool()
    for (const key of Object.keys(process.env)) if (!(key in savedEnv)) delete process.env[key]
    Object.assign(process.env, savedEnv)
    resetEnvCache()
    for (const o of orgs) await dropOrg(prisma, o)
    await dropFakeDealflow(admin, SCHEMA)
    await admin?.end()
  })

  const call = () =>
    morningCopy(new NextRequest('https://crm.example/api/cron/dealflow-signal-sync', { headers: { authorization: `Bearer ${SECRET}` } }))

  it('the cron route: an empty DealFlow list is still 200 ok:false; a list that matches nobody is 409, writing nothing', async () => {
    const dfOrg = await fake.org('dealflow-ryan') // the CRM organization the route copies into
    const empty = await call()
    expect(empty.status).toBe(200)
    expect(await empty.json()).toMatchObject({ ok: false, skipped: 'empty' })

    const strangers = [await fake.seller(dfOrg, `${TAG}_s1`, 'no_such_lead_1'), await fake.seller(dfOrg, `${TAG}_s2`, null)]
    await fake.callList(dfOrg, strangers, new Date(Date.now() - HOUR))
    const signalsBefore = await prisma.dealFlowDerivedSignal.count()
    const refused = await call()
    expect(refused.status).toBe(409)
    expect(await refused.json()).toMatchObject({ ok: false, skipped: 'no_leads_matched', signalsUpserted: 0, leadsCleared: 0 })
    expect(await prisma.dealFlowDerivedSignal.count()).toBe(signalsBefore)
  })

  it("the Queue's line: yesterday's order is still shown because this morning's list reached 1 of the usual 4", async () => {
    const slug = `${TAG}_queue`
    const organizationId = await makeOrg(prisma, slug)
    orgs.push(organizationId)
    const dfOrg = await fake.org(slug)
    // Yesterday's copy (before the last scheduled one): 4 leads, 4 signals.
    const due = lastScheduledCopy(new Date())
    const copiedAt = new Date(due.getTime() - 24 * HOUR + 5_000)
    const sellers: string[] = []
    for (let i = 0; i < 4; i += 1) {
      const lead = await makeLead(prisma, organizationId, { displayName: `Test Owner ${i + 1}`, mojoId: `${slug}_m${i}` })
      sellers.push(await fake.seller(dfOrg, `${slug}_m${i}`, lead))
      await prisma.dealFlowDerivedSignal.create({
        data: {
          organizationId, mojoId: `${slug}_m${i}`, queueRank: i + 1, priorityScore: 90 - i, syncedAt: copiedAt,
          dealflowRawJson: { crmLeadId: lead, generationRunId: `${slug}_yesterday`, generatedAt: new Date(copiedAt.getTime() - 2 * HOUR).toISOString() },
        },
      })
    }
    expect(await MorningCopyNotice({ organizationId })).toBeNull() // DealFlow has no newer list yet

    // This morning's list, made before the copy ran: 1 of the 4.
    await fake.callList(dfOrg, [sellers[0]], new Date(due.getTime() - 90 * 60_000))
    const el = await MorningCopyNotice({ organizationId })
    const html = el === null ? null : renderToStaticMarkup(el).replace(/&#x27;/g, "'")
    const day = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', month: 'short', day: 'numeric' }).format(copiedAt)
    expect(html).toMatch(/^<div role="status"/)
    expect(html).toContain(
      `This morning's ranking from DealFlow looked wrong (it reached 1 of your usual 4 sellers), so the Queue still shows ${day}'s order.`,
    )
  })
})
