import { describe, it, expect } from 'vitest'
import { createHash } from 'node:crypto'
import {
  CLEAR_STALE_LEADS_SQL,
  ENSURE_VIEW_SQL,
  ENSURE_WINDOW_SQL,
  FILL_TIMEZONES_SQL,
  MORNING_GUARD_LEADS_SQL,
  MORNING_GUARD_SIGNALS_SQL,
  NOTHING_MAPPED_GUARD_SQL,
  REMOVE_STALE_SIGNALS_SQL,
  UPDATE_LEADS_SQL,
  UPSERT_SAME_ORG_SQL,
  UPSERT_SIGNALS_SQL,
  batchGeneratedAt,
  syncStatements,
} from '@/lib/core-data/dealflow-sync/write'
import { buildSignals, stubBatch } from '@/lib/core-data/dealflow-sync/sync'

// Brief 45 PR F — the morning-sync guard (CONTRACT §7). The 7:00 copy of
// DealFlow's call list must not wipe the rank or signals an upload's scoring
// wrote after DealFlow made that list (an upload between DealFlow's 5:00 run
// and the CRM's 7:00 copy). Everything else about the morning sync stays byte
// for byte the same: the SHA-256 of every statement's text on main (aa10534 /
// PR A 239c5f8) is pinned below. Pure (the DB proof is
// tests/dealflow-sync.guard.test.ts).
// Brief 50 (PR 11) added one condition at the end of two statements, and
// nothing else: the upsert leaves another organization's signal alone
// (UPSERT_SAME_ORG_SQL), and the clear clears nothing for a batch that maps to
// no lead (NOTHING_MAPPED_GUARD_SQL). The DB proof is
// tests/dealflow-sync.safety.test.ts.
const sha = (s: string) => createHash('sha256').update(s, 'utf8').digest('hex')
const ON_MAIN = {
  UPSERT_SIGNALS_SQL: 'e6c3f99c02cfce354e1eb5ad90d7446246bdf12e648dbafefae38d134240cfbd',
  REMOVE_STALE_SIGNALS_SQL: 'd2a91890347cbed792f03d1ba3941381bf37bfb9913b4c965b45d5fdc679d91d',
  UPDATE_LEADS_SQL: 'aba1bbb6ea211578c419d924675a08859dbbf5d14af45e2f2faa49f82caa1050',
  CLEAR_STALE_LEADS_SQL: '393d6dff64e221bf48c121239088c40b5ffc49c91aac6fde5773cad638be5c57',
  FILL_TIMEZONES_SQL: '8c1765dbc263d71789c85c7aa9b9b1e2c7e0437ff124ea70f7eabed608474613',
  ENSURE_VIEW_SQL: '3a4c6187917432e5fd9ac1ba79b6403aeda8ddeaa84e4ad56864b362f5bdbceb',
  ENSURE_WINDOW_SQL: 'c105b751efdc67ed9ce463c0b09081f5eab12cb74b1e9fbf68c44d620547dcc5',
}
const flat = (sql: string) => sql.replace(/\s+/g, ' ').trim()

describe('the morning sync is unchanged apart from the guard', () => {
  it('four statements are byte for byte what they were', () => {
    expect(sha(UPDATE_LEADS_SQL)).toBe(ON_MAIN.UPDATE_LEADS_SQL)
    expect(sha(FILL_TIMEZONES_SQL)).toBe(ON_MAIN.FILL_TIMEZONES_SQL)
    expect(sha(ENSURE_VIEW_SQL)).toBe(ON_MAIN.ENSURE_VIEW_SQL)
    expect(sha(ENSURE_WINDOW_SQL)).toBe(ON_MAIN.ENSURE_WINDOW_SQL)
  })

  it('the two whole-batch statements are what they were, plus one condition at the end', () => {
    // Brief 50 (PR 11): the clear then ends with the nothing-mapped condition.
    expect(CLEAR_STALE_LEADS_SQL.endsWith(MORNING_GUARD_LEADS_SQL + NOTHING_MAPPED_GUARD_SQL)).toBe(true)
    expect(sha(CLEAR_STALE_LEADS_SQL.slice(0, -(MORNING_GUARD_LEADS_SQL + NOTHING_MAPPED_GUARD_SQL).length))).toBe(ON_MAIN.CLEAR_STALE_LEADS_SQL)
    expect(REMOVE_STALE_SIGNALS_SQL.endsWith(MORNING_GUARD_SIGNALS_SQL)).toBe(true)
    expect(sha(REMOVE_STALE_SIGNALS_SQL.slice(0, -MORNING_GUARD_SIGNALS_SQL.length))).toBe(ON_MAIN.REMOVE_STALE_SIGNALS_SQL)
  })

  it('the condition keeps only what was written after DealFlow generated the batch, and is off without a batch time', () => {
    // A tie (the same millisecond) is cleared, as before: only "after" is kept.
    expect(flat(MORNING_GUARD_LEADS_SQL)).toBe(
      `AND ($3::timestamptz IS NULL OR l."dealflowSignalSyncedAt" IS NULL OR l."dealflowSignalSyncedAt" <= ($3::timestamptz AT TIME ZONE 'UTC'))`,
    )
    expect(flat(MORNING_GUARD_SIGNALS_SQL)).toBe(`AND ($3::timestamptz IS NULL OR "syncedAt" <= ($3::timestamptz AT TIME ZONE 'UTC'))`)
  })
})

describe('Brief 50 (PR 11): two conditions added, nothing else changed', () => {
  it('the upsert is what it was, plus: only a signal of the same organization is updated', () => {
    expect(UPSERT_SIGNALS_SQL.endsWith(UPSERT_SAME_ORG_SQL)).toBe(true)
    expect(sha(UPSERT_SIGNALS_SQL.slice(0, -UPSERT_SAME_ORG_SQL.length))).toBe(ON_MAIN.UPSERT_SIGNALS_SQL)
    expect(flat(UPSERT_SAME_ORG_SQL)).toBe(`WHERE "DealFlowDerivedSignal"."organizationId" = EXCLUDED."organizationId"`)
  })

  it('the clear clears nothing when the batch maps to no lead', () => {
    expect(flat(NOTHING_MAPPED_GUARD_SQL)).toBe('AND EXISTS (SELECT 1 FROM mapped)')
  })
})

describe("the batch's generatedAt goes to exactly those two statements", () => {
  const now = new Date('2026-10-18T11:00:00.000Z')
  const signals = buildSignals(stubBatch(now))

  it('read from the batch rows (all rows of one run share it)', () => {
    expect(batchGeneratedAt(signals)).toBe(now.toISOString())
    expect(batchGeneratedAt([])).toBeNull()
    expect(batchGeneratedAt(signals.map((s) => ({ ...s, dealflowRawJson: { ...s.dealflowRawJson, generatedAt: null } })))).toBeNull()
    expect(batchGeneratedAt(signals.map((s) => ({ ...s, dealflowRawJson: { ...s.dealflowRawJson, generatedAt: 'not a date' } })))).toBeNull()
  })

  it('every other statement keeps its parameters', () => {
    const st = syncStatements('org_1', signals)
    const bySql = new Map(st.map(([sql, ...params]) => [sql, params]))
    expect(bySql.get(CLEAR_STALE_LEADS_SQL)).toEqual([expect.any(String), 'org_1', now.toISOString()])
    expect(bySql.get(REMOVE_STALE_SIGNALS_SQL)).toEqual([expect.any(String), 'org_1', now.toISOString()])
    expect(bySql.get(UPDATE_LEADS_SQL)).toEqual([expect.any(String), 'org_1'])
    expect(bySql.get(UPSERT_SIGNALS_SQL)).toEqual([expect.any(String), 'org_1'])
    expect(st.map(([sql]) => sql)).toEqual([
      UPSERT_SIGNALS_SQL, REMOVE_STALE_SIGNALS_SQL, UPDATE_LEADS_SQL, CLEAR_STALE_LEADS_SQL, FILL_TIMEZONES_SQL, ENSURE_VIEW_SQL, ENSURE_WINDOW_SQL,
    ])
  })
})
