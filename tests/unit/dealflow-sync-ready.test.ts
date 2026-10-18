import { describe, it, expect, vi, afterEach } from 'vitest'
import pg from 'pg'
import { fetchDealflowBatch, RO_SQL, RO_SQL_WITHOUT_PROPERTY, VALUATIONS_READY_SQL } from '@/lib/core-data/dealflow-sync/sync'
import { assertReadOnlySql, closeDealflowRoPool } from '@/lib/core-data/dealflow-sync/ro-client'

// Brief 44 (PR 5), engineering precaution: before DealFlow's valuation tables
// exist (data step V1), the morning sync still reads and writes ranks and
// buyers, with no property, instead of failing whole. No database: the pool's
// connect() hands out stand-in clients.
function fakeDealflow(ready: boolean | null) {
  const sent: string[] = []
  vi.spyOn(pg.Pool.prototype, 'connect').mockImplementation((async () => ({
    release: vi.fn(),
    query: vi.fn(async (q: string | { text: string }) => {
      const text = typeof q === 'string' ? q : q.text
      sent.push(text)
      return { rows: text === VALUATIONS_READY_SQL ? [{ ready }] : [] }
    }),
  })) as never)
  return sent
}

afterEach(async () => {
  vi.restoreAllMocks()
  await closeDealflowRoPool()
  delete process.env.DATABASE_URL_DEALFLOW_RO
})

describe('the sync before and after DealFlow V1', () => {
  it('every read is one read-only statement; the fallback names no valuation table', () => {
    for (const sql of [VALUATIONS_READY_SQL, RO_SQL, RO_SQL_WITHOUT_PROPERTY]) expect(() => assertReadOnlySql(sql)).not.toThrow()
    expect(RO_SQL_WITHOUT_PROPERTY).not.toMatch(/PropertyValuation|ValuationRun/)
    expect(RO_SQL_WITHOUT_PROPERTY).toContain('NULL::jsonb AS property')
  })

  for (const [ready, sends] of [[true, 'RO_SQL'], [false, 'RO_SQL_WITHOUT_PROPERTY'], [null, 'RO_SQL_WITHOUT_PROPERTY']] as const) {
    it(`tables there: ${ready} -> sends ${sends}`, async () => {
      process.env.DATABASE_URL_DEALFLOW_RO = 'postgresql://nobody@127.0.0.1:1/none' // an address nothing listens on
      const sent = fakeDealflow(ready)
      await fetchDealflowBatch()
      expect(sent).toContain(sends === 'RO_SQL' ? RO_SQL : RO_SQL_WITHOUT_PROPERTY)
      expect(sent).not.toContain(sends === 'RO_SQL' ? RO_SQL_WITHOUT_PROPERTY : RO_SQL)
    })
  }
})
