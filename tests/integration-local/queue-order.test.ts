import 'dotenv/config'
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { prisma } from '@/lib/prisma'
import { getQueue, queueOrder } from '@/lib/core-data/smart-view/queue-service'
import { getReviewList } from '@/lib/core-data/smart-view/review-list'
import { DEFAULT_VIEW } from '@/lib/core-data/smart-view/defaultView'
import { applySync } from '@/lib/core-data/dealflow-sync/write'
import { buildSignals, type DealflowJoinRow } from '@/lib/core-data/dealflow-sync/sync'
import { IMPORT_SCORING_SOURCE } from '@/lib/core-data/dealflow-score/marker'
import { compile } from '@/lib/core-data/query-dsl/compiler'
import { execute, executeCount } from '@/lib/core-data/query-dsl/executor'
import type { BatchCaller } from '@/lib/core-data/query-dsl/compliance-bridge'
import type { SQuery } from '@/lib/core-data/query-dsl/schema'
import { mainIsTestDb } from '../setup/live-guard'

// Brief 50 PR 10 (open item 6.8): the Queue lists leads in DealFlow's own
// call-list order. The CRM stores DealFlow's priority rounded to a whole number
// (sync.ts), so two sellers DealFlow told apart (87.4 vs 87.2) tie in the CRM,
// and exact ties fell to "top match" and then the lead id instead of DealFlow's
// rank. Real Postgres, inside two throwaway organizations, made-up people
// only (phones in the fictional 555-0100..0199 range). Nothing here calls,
// texts or emails anyone: the compliance check is a stand-in that says yes.
const enabled = mainIsTestDb() // refuses a live DATABASE_URL_MAIN; skips when it's unset

const TAG = `b50q_${Date.now()}`

// Every phone is callable and none is ever dialed: getQueue only asks.
const yes: BatchCaller = async (body) =>
  body.entries.map((e) => ({ contactPhoneId: e.contactPhoneId, phone: e.phone, callable: true, reasons: [] }))

// Lead ids are chosen so their alphabetical order disagrees with DealFlow's.
const id = (k: string) => `${TAG}_${k}`
const RANKED = [
  // key, DealFlow rank, DealFlow priority (unrounded), top match fit, mapped by
  { k: 'k', rank: 1, priority: 87.2, fit: 60, by: 'crmLeadId' }, // 87 in the CRM
  { k: 'j', rank: 2, priority: 87.4, fit: 90, by: 'mojoId' }, //   87 in the CRM, better fit
  { k: 'z', rank: 3, priority: 80, fit: 50, by: 'crmLeadId' }, //  exact tie with 'a' ...
  { k: 'a', rank: 4, priority: 80, fit: 50, by: 'crmLeadId' }, //  ... whose id sorts first
  { k: 'm', rank: 5, priority: 79.6, fit: 95, by: 'crmLeadId' }, // rounds UP to 80, best fit
  { k: 'b', rank: 6, priority: 70, fit: 70, by: 'crmLeadId' },
] as const
// Scored by an upload after the morning copy: a priority, but no place on
// DealFlow's list yet (queueRank NULL until the next morning).
const UNRANKED = [
  { k: 'c', priority: 99, fit: 99 },
  { k: 'y', priority: 40, fit: 40 },
  { k: 'd', priority: 40, fit: 40 }, // tie with 'y': lead id decides (d before y)
] as const
// Never scored at all: no priority, no signal.
const UNSCORED = ['f', 'e'] as const

const DEALFLOW_ORDER = ['k', 'j', 'z', 'a', 'm', 'b'].map(id)
const UPLOAD_ORDER = ['c', 'd', 'y'].map(id)
const UNSCORED_ORDER = ['e', 'f'].map(id)

let org: string
let otherOrg: string
let priorityView: string // the "DealFlow priority" view's query and sort
let everyoneView: string // every lead of the org, no saved sort (compileOrderBy's default)

const row = (over: Partial<DealflowJoinRow>): DealflowJoinRow => ({
  mojo_id: null, crm_lead_id: null, queue_rank: null, priority_score: null, queue_reason: 'Top match',
  primary_match_id: null, primary_match_fit: null, primary_capture_status: 'OWN_BUYER_ONLY',
  primary_match_confidence: 'MEDIUM', match_reason: 'Made-up buyer', contactId: null, contributions: {},
  generation_run_id: `${TAG}_run`, generated_at: new Date(Date.now() - 60_000).toISOString(), ...over,
})

describe.runIf(enabled)('Queue order = DealFlow rank (Brief 50 PR 10)', () => {
  beforeAll(async () => {
    org = (await prisma.organization.create({ data: { slug: id('org'), name: 'Brief 50 PR 10 queue order' } })).id
    otherOrg = (await prisma.organization.create({ data: { slug: id('other'), name: 'Brief 50 PR 10 other org' } })).id

    const keys = [...RANKED.map((r) => r.k), ...UNRANKED.map((u) => u.k), ...UNSCORED]
    for (const [i, k] of keys.entries()) {
      await prisma.lead.create({
        data: {
          id: id(k), organizationId: org, displayName: `Test Owner ${k}`, mojoId: id(`mojo_${k}`),
          timezone: 'America/New_York',
          contacts: {
            create: {
              organizationId: org, displayName: `Test Owner ${k}`, timezone: 'America/New_York',
              phones: { create: { phone: `+1212555${String(101 + i).padStart(4, '0')}`, type: 'mobile', isPrimary: true } },
            },
          },
        },
      })
    }

    // The morning copy, the real way: DealFlow's rows → buildSignals (which
    // rounds the priority) → applySync.
    const signals = buildSignals({
      includeTestBuyers: true,
      rows: RANKED.map((r) =>
        row({
          mojo_id: id(`mojo_${r.k}`), crm_lead_id: r.by === 'crmLeadId' ? id(r.k) : null,
          queue_rank: r.rank, priority_score: r.priority, primary_match_id: `m_${r.k}`, primary_match_fit: r.fit,
        }),
      ),
    })
    await applySync(org, signals, prisma)

    // An upload's scoring afterwards (dealflow-score/write.ts): the lead's
    // fields and a signal with no rank.
    for (const u of UNRANKED) {
      await prisma.lead.update({
        where: { id: id(u.k) },
        data: { priorityScore: u.priority, topMatchFit: u.fit, dealflowSignalSyncedAt: new Date() },
      })
      await prisma.dealFlowDerivedSignal.create({
        data: {
          organizationId: org, mojoId: id(`mojo_${u.k}`), queueRank: null, priorityScore: u.priority, primaryMatchFit: u.fit,
          dealflowRawJson: { source: IMPORT_SCORING_SOURCE, crmLeadId: id(u.k), queueRank: null, buyers: [] },
        },
      })
    }
    // Another organization's signal that names one of this org's leads with
    // rank 1: it must not move that lead.
    await prisma.dealFlowDerivedSignal.create({
      data: { organizationId: otherOrg, mojoId: id('mojo_foreign'), queueRank: 1, priorityScore: 1, dealflowRawJson: { crmLeadId: id('y') } },
    })

    priorityView = (await prisma.savedView.create({
      data: { organizationId: org, name: `${TAG} DealFlow priority`, type: 'lead', sQuery: DEFAULT_VIEW.sQuery as object, sort: DEFAULT_VIEW.sort as object },
    })).id
    everyoneView = (await prisma.savedView.create({
      data: { organizationId: org, name: `${TAG} everyone`, type: 'lead', sQuery: { type: 'match_all' }, sort: [] },
    })).id
  })

  afterAll(async () => {
    if (!org) return
    const orgs = [org, otherOrg].filter(Boolean)
    await prisma.dealFlowDerivedSignal.deleteMany({ where: { organizationId: { in: orgs } } })
    await prisma.savedView.deleteMany({ where: { organizationId: { in: orgs } } })
    await prisma.callingWindowConfig.deleteMany({ where: { organizationId: { in: orgs } } })
    await prisma.contactPhone.deleteMany({ where: { contact: { organizationId: { in: orgs } } } })
    await prisma.contact.deleteMany({ where: { organizationId: { in: orgs } } })
    await prisma.lead.deleteMany({ where: { organizationId: { in: orgs } } })
    await prisma.organization.deleteMany({ where: { id: { in: orgs } } })
  })

  it('the sync stores the rounded priority, so DealFlow\'s 87.4 and 87.2 tie at 87 (the display stays a whole number)', async () => {
    const leads = await prisma.lead.findMany({ where: { id: { in: [id('k'), id('j'), id('m')] } } })
    const p = Object.fromEntries(leads.map((l) => [l.id, l.priorityScore]))
    expect(p).toEqual({ [id('k')]: 87, [id('j')]: 87, [id('m')]: 80 })
  })

  it('the review list (/queue while calling is off) is in DealFlow\'s rank order, then the unranked by priority', async () => {
    const r = await getReviewList(priorityView, org)
    expect(r.leads.map((l) => l.leadId)).toEqual([...DEALFLOW_ORDER, ...UPLOAD_ORDER])
    expect(r.total).toBe(9)
    // The priority shown is unchanged: the stored whole number.
    expect(r.leads.slice(0, 2).map((l) => l.priorityScore)).toEqual([87, 87])
  })

  it('the dialer\'s queue (getQueue) is in the same order', async () => {
    const q = await getQueue(priorityView, org, { caller: yes })
    expect(q.leads.map((l) => l.leadId)).toEqual([...DEALFLOW_ORDER, ...UPLOAD_ORDER])
    expect(q.leads[0].ammunition.priorityScore).toBe(87)
  })

  it('a view with no saved sort (priority first) also follows DealFlow\'s rank; never-scored leads come last, by lead id', async () => {
    const q = await getQueue(everyoneView, org, { caller: yes })
    expect(q.leads.map((l) => l.leadId)).toEqual([...DEALFLOW_ORDER, ...UPLOAD_ORDER, ...UNSCORED_ORDER])
  })

  it('the order is stable: same answer twice, and every shorter queue is the start of the longer one', async () => {
    const full = (await getQueue(everyoneView, org, { caller: yes })).leads.map((l) => l.leadId)
    expect((await getQueue(everyoneView, org, { caller: yes })).leads.map((l) => l.leadId)).toEqual(full)
    for (let n = 1; n <= full.length; n++) {
      expect((await getQueue(everyoneView, org, { caller: yes, limit: n })).leads.map((l) => l.leadId)).toEqual(full.slice(0, n))
    }
  })

  it('paging through the order two at a time has no duplicates and no gaps', async () => {
    const sQuery: SQuery = { type: 'match_all' }
    const compiled = compile(sQuery, { organizationId: org, customFieldTypes: {} })
    const ordered = queueOrder(compiled, [], org)
    const total = await executeCount(compiled, prisma, org)
    const seen: string[] = []
    for (let offset = 0; offset < total + 2; offset += 2) {
      const page = await execute<{ id: string }>(ordered.compiled, prisma, {
        organizationId: org, selectSql: 'lead.id', orderBySql: ordered.orderBySql, limit: 2, offset,
      })
      seen.push(...page.map((p) => p.id))
    }
    expect(total).toBe(11)
    expect(seen).toEqual([...DEALFLOW_ORDER, ...UPLOAD_ORDER, ...UNSCORED_ORDER])
    expect(new Set(seen).size).toBe(seen.length)
  })
})
