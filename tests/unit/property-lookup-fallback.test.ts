import { describe, it, expect, vi, beforeAll, beforeEach, afterEach, afterAll } from 'vitest'
import pg from 'pg'
import type { PrismaClient } from '@prisma/client'
import { closeDealflowRoPool } from '@/lib/core-data/dealflow-sync/ro-client'
import { getLeadProperty } from '@/lib/core-data/dealflow-sync/property-lookup'
import { logger } from '@/lib/logger'
import { rawProperty } from './helpers/property-fixture'

// Brief 50 (PR 12), open item 5.7: for a lead with no stored value (not on
// DealFlow's call list), the card reads that one seller's value from DealFlow.
// That read must never hold up or break the lead page [engineering
// precaution]: past the wait (2.5 s on the page) or on any failure there is
// simply no card, and the page renders as before. No database here: the
// CRM side is a stand-in, and the read-only pool's connect() hands out
// stand-in clients (tests/dealflow-sync.property-fallback.test.ts runs it on a
// real Postgres).

// A stand-in CRM: no stored signal for the lead; the organization's slug.
function crm(slug: string | null = 'dealflow-ryan', otherLeads: string[] = []) {
  const db = {
    $queryRaw: async () => [],
    organization: { findUnique: async () => (slug === null ? null : { slug }) },
    lead: { count: async ({ where }: { where: { id: string } }) => (otherLeads.includes(where.id) ? 1 : 0) },
  }
  return db as unknown as PrismaClient
}

// DealFlow answers the lead's statement with `rows` (after `delayMs`), or fails.
function fakeDealflow(answer: { rows?: unknown[]; fail?: Error; delayMs?: number } = {}) {
  const texts: string[] = []
  const values: unknown[] = []
  const connect = vi.spyOn(pg.Pool.prototype, 'connect').mockImplementation((async () => ({
    release: vi.fn(),
    on: vi.fn(),
    removeListener: vi.fn(),
    query: vi.fn(async (q: string | { text: string; values?: unknown[] }) => {
      const text = typeof q === 'string' ? q : q.text
      texts.push(text)
      if (text === 'BEGIN READ ONLY' || text === 'ROLLBACK') return { rows: [] }
      values.push(typeof q === 'string' ? undefined : q.values)
      if (answer.delayMs) await new Promise((resolve) => setTimeout(resolve, answer.delayMs))
      if (answer.fail) throw answer.fail
      return { rows: answer.rows ?? [] }
    }),
  })) as never)
  return { texts, values, connect }
}

const LEAD = { id: 'lead_1', mojoId: 'mojo_1' }
let savedEnv: Record<string, string | undefined> = {}
let warn: ReturnType<typeof vi.spyOn>
beforeAll(() => {
  savedEnv = { ...process.env }
})
beforeEach(async () => {
  await closeDealflowRoPool()
  delete process.env.DEALFLOW_SYNC_STUB
  // An address nothing listens on: connect() is replaced, no socket is opened.
  process.env.DATABASE_URL_DEALFLOW_RO = 'postgresql://u:p@127.0.0.1:9/dealflow_ro_unit_test'
  warn = vi.spyOn(logger, 'warn').mockImplementation(() => undefined)
})
afterEach(async () => {
  vi.restoreAllMocks()
  await closeDealflowRoPool()
})
afterAll(() => {
  for (const key of Object.keys(process.env)) if (!(key in savedEnv)) delete process.env[key]
  Object.assign(process.env, savedEnv)
})

describe("a lead with no stored value: DealFlow's value for that one seller", () => {
  it('found by the CRM lead id DealFlow keeps: whitelisted, with the organization slug and the lead as the only inputs', async () => {
    const f = fakeDealflow({ rows: [{ crm_lead_id: 'lead_1', mojo_id: 'mojo_1', property: { ...rawProperty(), ownerName: 'Pat Example' } }] })
    expect(await getLeadProperty('org_1', LEAD, crm())).toEqual(rawProperty())
    expect(f.values).toEqual([['dealflow-ryan', 'lead_1', 'mojo_1']])
    expect(f.texts[0]).toBe('BEGIN READ ONLY') // through the read-only client
  })

  it('found by Mojo ID only when DealFlow gave that seller to no other lead of the organization', async () => {
    fakeDealflow({ rows: [{ crm_lead_id: 'lead_9', mojo_id: 'mojo_1', property: rawProperty() }] })
    expect(await getLeadProperty('org_1', LEAD, crm('dealflow-ryan', ['lead_9']))).toBeNull()
    expect(await getLeadProperty('org_1', LEAD, crm('dealflow-ryan', []))).toEqual(rawProperty())
  })

  it('DealFlow answers too slowly: no card once the wait is over (never the late answer), and a short log line', async () => {
    fakeDealflow({ rows: [{ crm_lead_id: 'lead_1', mojo_id: 'mojo_1', property: rawProperty() }], delayMs: 200 })
    const started = Date.now()
    expect(await getLeadProperty('org_1', LEAD, crm(), 20)).toBeNull()
    expect(Date.now() - started).toBeLessThan(150)
    expect(warn).toHaveBeenCalledTimes(1)
    expect(JSON.stringify(warn.mock.calls[0])).toContain('timeout')
  })

  it('DealFlow fails or cannot be reached: no card, no error for the page, and the log line holds no address', async () => {
    fakeDealflow({ fail: Object.assign(new Error('relation "PropertyValuation" does not exist'), { code: '42P01' }) })
    expect(await getLeadProperty('org_1', LEAD, crm())).toBeNull()
    vi.restoreAllMocks()
    warn = vi.spyOn(logger, 'warn').mockImplementation(() => undefined)
    const refused = Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:9'), { code: 'ECONNREFUSED' })
    vi.spyOn(pg.Pool.prototype, 'connect').mockRejectedValue(refused as never)
    expect(await getLeadProperty('org_1', LEAD, crm())).toBeNull()
    const logged = JSON.stringify(warn.mock.calls)
    expect(logged).toContain('ECONNREFUSED')
    expect(logged).not.toMatch(/127\.0\.0\.1|postgresql:|dealflow_ro_unit_test/)
  })

  it('no DealFlow setting, stub mode, or no organization: no read at all', async () => {
    const f = fakeDealflow({ rows: [{ crm_lead_id: 'lead_1', mojo_id: 'mojo_1', property: rawProperty() }] })
    expect(await getLeadProperty('org_1', LEAD, crm(null))).toBeNull()
    process.env.DEALFLOW_SYNC_STUB = '1'
    expect(await getLeadProperty('org_1', LEAD, crm())).toBeNull()
    delete process.env.DEALFLOW_SYNC_STUB
    delete process.env.DATABASE_URL_DEALFLOW_RO
    expect(await getLeadProperty('org_1', LEAD, crm())).toBeNull()
    expect(f.connect).not.toHaveBeenCalled()
  })
})
