import { describe, it, expect } from 'vitest'
import {
  RO_SQL,
  RUN_INFO_SQL,
  MAX_BATCH_AGE_MS,
  checkFreshness,
  stubBatch,
  type DealflowJoinRow,
} from '@/lib/core-data/dealflow-sync/sync'
import {
  CLEAR_STALE_LEADS_SQL,
  REMOVE_STALE_SIGNALS_SQL,
  UPDATE_LEADS_SQL,
  EASTERN_STATES,
} from '@/lib/core-data/dealflow-sync/write'
import { compile, compileOrderBy } from '@/lib/core-data/query-dsl/compiler'
import { buildSql } from '@/lib/core-data/query-dsl/executor'
import { DEFAULT_VIEW, DEFAULT_VIEW_ID } from '@/lib/core-data/smart-view/defaultView'
import { reviewQuery, REVIEW_SELECT } from '@/lib/core-data/smart-view/review-list'

// Brief 37 unit tests (pure). The DB-backed proofs of stale-clearing, the
// timezone rule and the ">= 0" filter live in tests/dealflow-sync.write.test.ts.
const flat = (sql: string) => sql.replace(/\s+/g, ' ')

describe('batch selection (RO_SQL)', () => {
  it('reads the whole run that owns the newest generatedAt, in rank order, with no cap', () => {
    const sql = flat(RO_SQL)
    expect(sql).toContain('WITH latest AS ( SELECT "generationRunId" FROM "CallQueueEntry" ORDER BY "generatedAt" DESC LIMIT 1 )')
    expect(sql).toContain('JOIN "CallQueueEntry" cqe ON cqe."generationRunId" = latest."generationRunId"')
    expect(sql.trim().endsWith('ORDER BY cqe."rank"')).toBe(true)
    expect(sql).not.toMatch(/LIMIT 500|MAX\("generatedAt"\)/)
    expect(sql.match(/LIMIT/g)).toHaveLength(1) // only inside `latest`
  })

  it('reads generatedAt as UTC (the column has no time zone), whatever the server TZ', () => {
    expect(flat(RO_SQL)).toContain(`cqe."generatedAt" AT TIME ZONE 'UTC' AS generated_at`)
  })

  it('carries the CRM lead id and the top match', () => {
    expect(flat(RO_SQL)).toContain(`mc."metadata"->>'crmLeadId' AS crm_lead_id`)
    expect(flat(RO_SQL)).toContain('LEFT JOIN "Match" m ON m."id" = cqe."primaryMatchId"')
  })

  it("reads includeTestBuyers from DealFlow's latest NIGHTLY_SCORING row", () => {
    const sql = flat(RUN_INFO_SQL)
    expect(sql).toContain(`("detailsJson"->>'includeTestBuyers')::boolean`)
    expect(sql).toContain(`WHERE "action" = 'NIGHTLY_SCORING' ORDER BY "createdAt" DESC LIMIT 1`)
  })
})

describe('freshness guard', () => {
  const now = new Date('2026-09-28T11:00:00Z')
  const at = (msAgo: number): DealflowJoinRow[] => [
    { ...stubBatch(now).rows[0], generated_at: new Date(now.getTime() - msAgo).toISOString() },
  ]

  it('accepts a batch up to 36h old', () => {
    expect(checkFreshness(at(2 * 3_600_000), now)).toMatchObject({ ok: true })
    expect(checkFreshness(at(MAX_BATCH_AGE_MS), now)).toMatchObject({ ok: true })
  })

  it('refuses a batch older than 36h', () => {
    expect(checkFreshness(at(MAX_BATCH_AGE_MS + 1), now)).toMatchObject({ ok: false, reason: 'stale' })
  })

  it('refuses an empty batch, or one with no usable mojoId', () => {
    expect(checkFreshness([], now)).toEqual({ ok: false, reason: 'empty', generatedAt: null })
    expect(checkFreshness([{ ...at(0)[0], mojo_id: null }], now)).toMatchObject({ ok: false, reason: 'empty' })
  })

  it('refuses a batch with a missing or garbage timestamp', () => {
    expect(checkFreshness([{ ...at(0)[0], generated_at: null }], now)).toMatchObject({ ok: false, reason: 'stale' })
    expect(checkFreshness([{ ...at(0)[0], generated_at: 'not a date' }], now)).toMatchObject({ ok: false, reason: 'stale' })
  })

  it('stub mode stays usable: the fixture is stamped with now', () => {
    expect(checkFreshness(stubBatch(now).rows, now).ok).toBe(true)
  })
})

describe('stale-clearing statements', () => {
  it('NULLs all six DealFlow fields on in-org leads that are not in the batch', () => {
    const sql = flat(CLEAR_STALE_LEADS_SQL)
    for (const col of ['priorityScore', 'topMatchFit', 'captureStatus', 'matchReason', 'dealflowDeepLink', 'dealflowSignalSyncedAt']) {
      expect(sql).toContain(`"${col}" = NULL`)
    }
    expect(sql).toContain('WHERE l."organizationId" = $2 AND l.id NOT IN (SELECT lead_id FROM mapped)')
  })

  it('maps batch rows by crmLeadId first, then mojoId, within the org', () => {
    const sql = flat(UPDATE_LEADS_SQL)
    expect(sql).toContain('COALESCE(by_id.id, by_mojo.id) AS lead_id')
    expect(sql).toContain('by_id.id = b."crmLeadId" AND by_id."organizationId" = $2')
    expect(sql).toContain('by_mojo."mojoId" = b."mojoId" AND by_mojo."organizationId" = $2')
  })

  it('removes signals whose mojoId left the batch', () => {
    expect(flat(REMOVE_STALE_SIGNALS_SQL)).toContain('WHERE "organizationId" = $2 AND "mojoId" NOT IN')
  })
})

describe('timezone rule', () => {
  it('lists only states wholly in the Eastern zone', () => {
    expect(EASTERN_STATES).toEqual(expect.arrayContaining(['NY', 'NJ', 'CT', 'PA', 'MA', 'GA']))
    for (const split of ['FL', 'IN', 'KY', 'MI', 'TN', 'TX', 'CA', 'IL', 'AZ', 'HI']) {
      expect(EASTERN_STATES).not.toContain(split)
    }
  })
})

describe('"DealFlow priority" default view', () => {
  it('uses the id the dialer already asks for', () => {
    expect(DEFAULT_VIEW_ID).toBe('save_default')
    expect(DEFAULT_VIEW.id).toBe(DEFAULT_VIEW_ID)
    expect(DEFAULT_VIEW.name).toBe('DealFlow priority')
  })

  it('compiles to a plain priorityScore >= 0 test, which SQL never satisfies for NULL', () => {
    const compiled = compile(DEFAULT_VIEW.sQuery, { organizationId: 'org', customFieldTypes: {} })
    expect(compiled.whereSql).toBe('lead."priorityScore" >= $1')
    expect(compiled.params).toEqual([0])
    expect(compiled.whereSql).not.toMatch(/NULL|\bOR\b/i)
  })

  it('sorts by priority, then top match fit, blanks last', () => {
    expect(compileOrderBy(DEFAULT_VIEW.sort)).toBe(
      'ORDER BY lead."priorityScore" DESC NULLS LAST, lead."topMatchFit" DESC NULLS LAST'
    )
  })

  it('the review list ANDs the priority filter onto any view, and selects no phone', () => {
    const compiled = compile(reviewQuery({ type: 'match_all' }), { organizationId: 'org', customFieldTypes: {} })
    expect(compiled.whereSql).toContain('lead."priorityScore" >= $')
    expect(buildSql(compiled, { organizationId: 'org' }).sql).toContain(`lead."organizationId" = $`)
    expect(REVIEW_SELECT).not.toMatch(/phone/i)
  })
})
