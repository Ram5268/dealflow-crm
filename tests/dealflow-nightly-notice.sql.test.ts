import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest'
import type pg from 'pg'
import { makePerfPool, perfConnectionString } from './setup/pg'
import { roQuery, closeDealflowRoPool } from '@/lib/core-data/dealflow-sync/ro-client'
import { NIGHTLY_NOTICE_SQL } from '@/lib/core-data/dealflow-sync/nightly-notice'

// Brief 47 (PR 6): the Queue notice's statement on a real Postgres, through the
// real read-only client. Suite 1: CI's db-suite job runs this on its throwaway
// Postgres (perfConnectionString() refuses anything but *_perf / *_test, never
// DealFlow's). The CRM has no AuditLog, so this file builds a DealFlow-shaped
// "AuditLog" (DealFlow's columns and types: createdAt is timestamp(3) without
// time zone holding UTC) in a scratch schema of its own, dropped afterwards.
// The read-only client reaches it through search_path, in a New York session
// time zone, so a 2-day window measured with a bare now() would be caught.
// Made-up rows only.
const SCHEMA = `b47_notice_${Date.now()}`
const TABLE = `"${SCHEMA}"."AuditLog"`
let admin: pg.Pool
let savedEnv: Record<string, string | undefined> = {}

type Row = { action: string; hoursAgo: number; details?: Record<string, unknown> }
let seq = 0
async function seed(rows: Row[]) {
  for (const r of rows) {
    seq += 1
    await admin.query(
      `INSERT INTO ${TABLE} ("id", "action", "detailsJson", "createdAt", "organizationId")
       VALUES ($1, $2, $3::jsonb, (now() AT TIME ZONE 'UTC') - make_interval(hours => $4), 'org_test')`,
      [`row_${seq}`, r.action, JSON.stringify(r.details ?? {}), r.hoursAgo],
    )
  }
}
const notice = async () => roQuery<{ notice: string | null }>(NIGHTLY_NOTICE_SQL)

// Made-up nightly details, as DealFlow writes them (CONTRACT.md).
const good = { sellers: 10, buyers: 5, kept: 20, sellersCovered: 8 }
const usedOurValues = { ...good, ourEstimates: { rolledBack: false, reasons: [], sellersPricedByOurValue: 7 } }
const rolledBack = { ...good, ourEstimates: { rolledBack: true, reasons: ['too_few_priced'], sellersPricedByOurValue: 0 } }
const scoringRefused = { reasons: ['no_buyers'], sellers: 10, buyers: 0, kept: 0, sellersCovered: 0, existingMatches: 20, existingSellersCovered: 8, includeTestBuyers: false }
const listRefused = { reasons: ['empty_list'], totalContactsConsidered: 10, exclusionCounts: {}, queueLength: 0 }

beforeAll(async () => {
  savedEnv = { ...process.env }
  await closeDealflowRoPool()
  const ro = new URL(perfConnectionString())
  ro.searchParams.set('options', `-c search_path=${SCHEMA} -c TimeZone=America/New_York`)
  process.env.DATABASE_URL_DEALFLOW_RO = ro.toString()
  admin = makePerfPool(2)
  await admin.query(`CREATE SCHEMA "${SCHEMA}"`)
  await admin.query(`CREATE TABLE ${TABLE} (
    "id" text PRIMARY KEY,
    "action" text NOT NULL,
    "detailsJson" jsonb,
    "createdAt" timestamp(3) without time zone NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "organizationId" text NOT NULL)`)
})

beforeEach(async () => {
  await admin.query(`TRUNCATE ${TABLE}`)
})

afterAll(async () => {
  await closeDealflowRoPool()
  for (const key of Object.keys(process.env)) if (!(key in savedEnv)) delete process.env[key]
  Object.assign(process.env, savedEnv)
  await admin?.query(`DROP SCHEMA IF EXISTS "${SCHEMA}" CASCADE`)
  await admin?.end()
})

describe("the Queue notice's statement on a real Postgres", () => {
  it('runs in a New York session (so the UTC window is really tested)', async () => {
    expect(await roQuery<{ tz: string }>('SELECT current_setting(\'TimeZone\') AS tz')).toEqual([{ tz: 'America/New_York' }])
  })

  it('no rows: one row, only the code, null', async () => {
    const rows = await notice()
    expect(rows).toEqual([{ notice: null }])
    expect(Object.keys(rows[0])).toEqual(['notice'])
  })

  it('a good night, with or without our values: null', async () => {
    await seed([{ action: 'NIGHTLY_SCORING', hoursAgo: 6, details: good }, { action: 'CALL_QUEUE_BUILD', hoursAgo: 6 }])
    expect(await notice()).toEqual([{ notice: null }])
    await seed([{ action: 'NIGHTLY_SCORING', hoursAgo: 5, details: usedOurValues }, { action: 'CALL_QUEUE_BUILD', hoursAgo: 5 }])
    expect(await notice()).toEqual([{ notice: null }])
  })

  it('the newest scoring row is NIGHTLY_SCORING_REFUSED: refused', async () => {
    await seed([
      { action: 'NIGHTLY_SCORING', hoursAgo: 30, details: good },
      { action: 'CALL_QUEUE_BUILD', hoursAgo: 30 },
      { action: 'CRM_LEAD_SYNC', hoursAgo: 6 },
      { action: 'NIGHTLY_SCORING_REFUSED', hoursAgo: 6, details: scoringRefused },
      { action: 'CRM_LEAD_SYNC', hoursAgo: 1 }, // a later unrelated row changes nothing
    ])
    expect(await notice()).toEqual([{ notice: 'refused' }])
  })

  it('the newest NIGHTLY_SCORING rolled our values back: rollback', async () => {
    await seed([
      { action: 'NIGHTLY_SCORING', hoursAgo: 30, details: usedOurValues },
      { action: 'NIGHTLY_SCORING', hoursAgo: 6, details: rolledBack },
      { action: 'VALUATION_SWITCH_ROLLBACK', hoursAgo: 6, details: rolledBack.ourEstimates },
      { action: 'CALL_QUEUE_BUILD', hoursAgo: 6 },
    ])
    expect(await notice()).toEqual([{ notice: 'rollback' }])
  })

  it('a rollback, then a later NIGHTLY_SCORING without it: null', async () => {
    await seed([
      { action: 'NIGHTLY_SCORING', hoursAgo: 20, details: rolledBack },
      { action: 'CALL_QUEUE_BUILD', hoursAgo: 20 },
      { action: 'NIGHTLY_SCORING', hoursAgo: 2, details: good },
    ])
    expect(await notice()).toEqual([{ notice: null }])
  })

  it('a refusal 3 days old: null; a rollback 3 days old: null', async () => {
    await seed([{ action: 'NIGHTLY_SCORING_REFUSED', hoursAgo: 72, details: scoringRefused }])
    expect(await notice()).toEqual([{ notice: null }])
    await seed([{ action: 'CALL_QUEUE_BUILD_REFUSED', hoursAgo: 72, details: listRefused }])
    expect(await notice()).toEqual([{ notice: null }])
    await admin.query(`TRUNCATE ${TABLE}`)
    await seed([{ action: 'NIGHTLY_SCORING', hoursAgo: 72, details: rolledBack }])
    expect(await notice()).toEqual([{ notice: null }])
  })

  it('the 2 days are measured in UTC: 46 hours ago counts, 50 hours ago does not', async () => {
    // In a New York session a bare now() would read the UTC times as New York
    // times, moving the edge by 4–5 hours, so the 50-hour row would count.
    await seed([{ action: 'NIGHTLY_SCORING_REFUSED', hoursAgo: 50, details: scoringRefused }])
    expect(await notice()).toEqual([{ notice: null }])
    await seed([{ action: 'NIGHTLY_SCORING_REFUSED', hoursAgo: 46, details: scoringRefused }])
    expect(await notice()).toEqual([{ notice: 'refused' }])
  })

  it('scoring was fine but the newest call-list row is CALL_QUEUE_BUILD_REFUSED: refused', async () => {
    await seed([
      { action: 'NIGHTLY_SCORING', hoursAgo: 30, details: good },
      { action: 'CALL_QUEUE_BUILD', hoursAgo: 30 },
      { action: 'NIGHTLY_SCORING', hoursAgo: 6, details: good },
      { action: 'CALL_QUEUE_BUILD_REFUSED', hoursAgo: 6, details: listRefused },
    ])
    expect(await notice()).toEqual([{ notice: 'refused' }])
  })

  it('a refused call list wins over a rollback the same night', async () => {
    await seed([
      { action: 'NIGHTLY_SCORING', hoursAgo: 6, details: rolledBack },
      { action: 'CALL_QUEUE_BUILD_REFUSED', hoursAgo: 6, details: listRefused },
    ])
    expect(await notice()).toEqual([{ notice: 'refused' }])
  })

  it('a refusal followed by a good night: null (scoring refusal, then call-list refusal)', async () => {
    await seed([
      { action: 'NIGHTLY_SCORING_REFUSED', hoursAgo: 30, details: scoringRefused },
      { action: 'NIGHTLY_SCORING', hoursAgo: 6, details: good },
      { action: 'CALL_QUEUE_BUILD', hoursAgo: 6 },
    ])
    expect(await notice()).toEqual([{ notice: null }])
    await admin.query(`TRUNCATE ${TABLE}`)
    await seed([
      { action: 'NIGHTLY_SCORING', hoursAgo: 30, details: good },
      { action: 'CALL_QUEUE_BUILD_REFUSED', hoursAgo: 30, details: listRefused },
      { action: 'NIGHTLY_SCORING', hoursAgo: 6, details: good },
      { action: 'CALL_QUEUE_BUILD', hoursAgo: 6 },
    ])
    expect(await notice()).toEqual([{ notice: null }])
  })
})
