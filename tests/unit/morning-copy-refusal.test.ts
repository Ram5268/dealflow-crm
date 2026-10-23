import { describe, it, expect, vi, beforeAll, beforeEach, afterEach, afterAll } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import pg from 'pg'
import { renderToStaticMarkup } from 'react-dom/server'
import { assertReadOnlySql, closeDealflowRoPool } from '@/lib/core-data/dealflow-sync/ro-client'
import { RO_SQL, NEWEST_LIST_SQL } from '@/lib/core-data/dealflow-sync/sync'
import { refuseBatch } from '@/lib/core-data/dealflow-sync/write'
import { REFUSED_COPY_STATUS, syncHttpStatus } from '@/lib/core-data/dealflow-sync/run'
import {
  COPY_HOUR_UTC,
  LAST_COPY_SQL,
  copyRefusalText,
  lastScheduledCopy,
  readCopyRefusal,
} from '@/lib/core-data/dealflow-sync/nightly-notice'
import { MorningCopyNotice } from '@/components/NightlyNoticeBanner'
import { logger } from '@/lib/logger'

// Brief 50 (PR 19), the planner's review (Revision 2): a refused morning copy
// shows on the Queue [Ryan's no-babysitting rule, 2026-10-18: checks show up
// in the product]. PR 11's size check (an engineering precaution) made the
// 7:00 copy from DealFlow refuse a list that reaches nobody, or fewer than
// half the sellers the last copy reached, and write nothing; but its cron
// answered 200, and the Queue said nothing. Pure, no database: a stand-in for
// the CRM's database is passed in, and the read-only pool's connect() hands
// out stand-in clients, as tests/unit/dealflow-nightly-notice.test.ts does
// (this suite also runs with isolate: false, where vi.mock would leak). The
// real-Postgres proofs are tests/dealflow-sync.refusal-notice.test.ts and
// tests/integration-local/morning-copy-refusal.test.ts.

const DAY = 86_400_000
const at = (iso: string) => new Date(iso)

describe('the cron answers a refused copy with a non-2xx code', () => {
  it('both refusals (matches nobody, too few) answer 409, so the cron log shows a failed run', () => {
    expect(REFUSED_COPY_STATUS).toBe(409)
    expect(syncHttpStatus({ skipped: 'no_leads_matched' })).toBe(409)
    expect(syncHttpStatus({ skipped: 'too_few_leads_matched' })).toBe(409)
  })

  it('a copy that went through answers 200, and an empty or stale DealFlow list stays 200 ok:false as before', () => {
    expect(syncHttpStatus({ skipped: undefined })).toBe(200)
    expect(syncHttpStatus({})).toBe(200)
    expect(syncHttpStatus({ skipped: 'empty' })).toBe(200)
    expect(syncHttpStatus({ skipped: 'stale' })).toBe(200)
  })

  it('the route sends that status with the same body (ok and skipped) as before', () => {
    const src = readFileSync(join(process.cwd(), 'src/app/api/cron/dealflow-signal-sync/route.ts'), 'utf8')
    expect(src).toContain('json({ ok: !result.skipped, ...result }, correlationId, { status: syncHttpStatus(result) })')
    // The job-key check is untouched: it still runs first and answers 401.
    expect(src.indexOf('isAuthorizedCron(req)')).toBeLessThan(src.indexOf('runDealflowSync('))
    expect(src).toContain("errorResponse('Unauthorized', 401, correlationId)")
  })
})

describe('refuseBatch compares like with like: leads now against the leads the last copy reached', () => {
  it('keeps both rules: no lead matched is refused; fewer than half the last copy\'s leads is refused', () => {
    expect(refuseBatch({ mappedLeads: 0, lastCopyLeads: 0 })).toBe('no_leads_matched')
    expect(refuseBatch({ mappedLeads: 0, lastCopyLeads: 1_478 })).toBe('no_leads_matched')
    expect(refuseBatch({ mappedLeads: 738, lastCopyLeads: 1_478 })).toBe('too_few_leads_matched')
    expect(refuseBatch({ mappedLeads: 739, lastCopyLeads: 1_478 })).toBeNull()
  })

  it('a first copy (nothing before it) is refused only when it matches no lead', () => {
    expect(refuseBatch({ mappedLeads: 1, lastCopyLeads: 0 })).toBeNull()
  })
})

describe('when the last scheduled copy ran (vercel.json, in UTC)', () => {
  it('the hour is the one vercel.json schedules the copy at', () => {
    const cron = JSON.parse(readFileSync(join(process.cwd(), 'vercel.json'), 'utf8')) as { crons: { path: string; schedule: string }[] }
    const copy = cron.crons.find((c) => c.path === '/api/cron/dealflow-signal-sync')
    expect(copy?.schedule).toBe(`0 ${COPY_HOUR_UTC} * * *`)
  })

  it("today's 11:00 UTC once the copy has had a few minutes to finish; yesterday's before that", () => {
    expect(lastScheduledCopy(at('2026-10-24T11:30:00Z')).toISOString()).toBe('2026-10-24T11:00:00.000Z')
    expect(lastScheduledCopy(at('2026-10-24T23:59:00Z')).toISOString()).toBe('2026-10-24T11:00:00.000Z')
    expect(lastScheduledCopy(at('2026-10-24T11:01:00Z')).toISOString()).toBe('2026-10-23T11:00:00.000Z')
    expect(lastScheduledCopy(at('2026-10-24T09:30:00Z')).toISOString()).toBe('2026-10-23T11:00:00.000Z')
    expect(lastScheduledCopy(at('2026-10-24T00:10:00Z')).toISOString()).toBe('2026-10-23T11:00:00.000Z')
  })
})

describe("the Queue's line (exact words, with N, M and the date)", () => {
  const now = at('2026-10-24T13:00:00Z')

  it('too few: the counts, with thousands separators, and the date of the order the Queue still shows', () => {
    expect(copyRefusalText({ reached: 600, usual: 1_478, copiedAt: at('2026-10-23T11:00:04Z') }, now)).toBe(
      "This morning's ranking from DealFlow looked wrong (it reached 600 of your usual 1,478 sellers), so the Queue still shows Oct 23's order.",
    )
  })

  it('matches nobody: N is 0', () => {
    expect(copyRefusalText({ reached: 0, usual: 1_478, copiedAt: at('2026-10-23T11:00:04Z') }, now)).toBe(
      "This morning's ranking from DealFlow looked wrong (it reached 0 of your usual 1,478 sellers), so the Queue still shows Oct 23's order.",
    )
  })

  it("the date is New York's, and carries the year only when it isn't this year", () => {
    // 02:00 UTC on Oct 24 is still Oct 23 in New York.
    expect(copyRefusalText({ reached: 1, usual: 4, copiedAt: at('2026-10-24T02:00:00Z') }, now)).toContain("still shows Oct 23's order.")
    expect(copyRefusalText({ reached: 1, usual: 4, copiedAt: at('2025-12-31T16:00:00Z') }, at('2026-01-02T13:00:00Z'))).toContain(
      "still shows Dec 31, 2025's order.",
    )
  })
})

describe("the statements", () => {
  const flat = (sql: string) => sql.replace(/\s+/g, ' ')

  it("DealFlow's newest list is one read-only statement the client accepts, and never reads a name, phone or email", () => {
    expect(() => assertReadOnlySql(NEWEST_LIST_SQL)).not.toThrow()
    expect(NEWEST_LIST_SQL).not.toMatch(/phone|email|fullName|address/i)
  })

  it('it picks the same newest list the copy reads (RO_SQL): same organization, same ordering, one run', () => {
    const pick = (sql: string) => flat(sql).match(/FROM "CallQueueEntry" q JOIN "Organization" o ON o\."id" = q\."organizationId" WHERE o\."slug" = \$1 ORDER BY q\."generatedAt" DESC LIMIT 1/)?.[0]
    expect(pick(RO_SQL)).toBeTruthy()
    expect(pick(NEWEST_LIST_SQL)).toBe(pick(RO_SQL))
    // The sellers come back only when the list isn't the one the CRM already holds ($2).
    expect(flat(NEWEST_LIST_SQL)).toContain('latest."generationRunId" IS DISTINCT FROM $2')
  })

  it("the CRM's last copy is the newest morning signal (an upload's scoring rows don't count)", () => {
    expect(flat(LAST_COPY_SQL)).toContain(`IS DISTINCT FROM 'import-scoring'`)
    expect(flat(LAST_COPY_SQL)).toContain('ORDER BY x."syncedAt" DESC LIMIT 1')
  })
})

// ── The line on the Queue page, through stand-ins ───────────────────────────

const ORG = 'org_unit_b50'
const COPIED_AT = at('2026-10-23T11:00:04Z') // yesterday's copy
const NOW = at('2026-10-24T13:00:00Z') // after this morning's 11:00 UTC copy

// A stand-in for the CRM's database: the last copy, and the counts the copy's
// own check (countBatchMapping) reads.
function crmDb(answer: { lastCopy?: unknown[]; mapping?: unknown[]; fail?: Error; hang?: boolean } = {}) {
  const sent: string[] = []
  const db = {
    $queryRawUnsafe: vi.fn(async (sql: string) => {
      sent.push(sql)
      if (answer.hang) await new Promise(() => undefined)
      if (answer.fail) throw answer.fail
      if (sql === LAST_COPY_SQL) return answer.lastCopy ?? [{ slug: 'dealflow-ryan', copiedAt: COPIED_AT, runId: 'run_yesterday' }]
      return answer.mapping ?? [{ mappedLeads: 1, lastCopyLeads: 4 }]
    }),
  }
  return { db: db as never, sent }
}

// DealFlow's newest list, through the real read-only client with stand-in connections.
function fakeDealflow(rows: unknown[]) {
  const texts: string[] = []
  const params: unknown[][] = []
  const connect = vi.spyOn(pg.Pool.prototype, 'connect').mockImplementation((async () => ({
    release: vi.fn(),
    on: vi.fn(),
    removeListener: vi.fn(),
    query: vi.fn(async (q: string | { text: string; values?: unknown[] }) => {
      const text = typeof q === 'string' ? q : q.text
      texts.push(text)
      if (text === NEWEST_LIST_SQL) {
        params.push(typeof q === 'string' ? [] : q.values ?? [])
        return { rows }
      }
      return { rows: [] }
    }),
  })) as never)
  return { texts, params, connect }
}

const newest = (over: Record<string, unknown> = {}) => ({
  run_id: 'run_today',
  generated_at: '2026-10-24T09:30:00.000Z',
  sellers: [{ mojoId: 'mojo_t1', crmLeadId: 'lead_t1' }],
  ...over,
})

let savedEnv: Record<string, string | undefined> = {}
let warn: ReturnType<typeof vi.spyOn>
beforeAll(() => {
  savedEnv = { ...process.env }
})
beforeEach(async () => {
  await closeDealflowRoPool()
  delete process.env.DEALFLOW_SYNC_STUB
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

describe('readCopyRefusal: the line shows only while a refusal is the newest copy attempt', () => {
  it("refused this morning: the line, with DealFlow's list counted by the copy's own check", async () => {
    const crm = crmDb()
    const f = fakeDealflow([newest()])
    expect(await readCopyRefusal(ORG, { now: NOW, db: crm.db })).toBe(
      "This morning's ranking from DealFlow looked wrong (it reached 1 of your usual 4 sellers), so the Queue still shows Oct 23's order.",
    )
    // DealFlow is asked for its newest list of this organization, with the run the CRM holds.
    expect(f.params).toEqual([['dealflow-ryan', 'run_yesterday']])
    expect(f.texts).toEqual(['BEGIN READ ONLY', NEWEST_LIST_SQL, 'ROLLBACK'])
    expect(warn).not.toHaveBeenCalled()
  })

  it('this morning\'s copy went through: no line, and DealFlow is not even asked', async () => {
    const crm = crmDb({ lastCopy: [{ slug: 'dealflow-ryan', copiedAt: at('2026-10-24T11:00:03Z'), runId: 'run_today' }] })
    const f = fakeDealflow([newest()])
    expect(await readCopyRefusal(ORG, { now: NOW, db: crm.db })).toBeNull()
    expect(f.connect).not.toHaveBeenCalled()
  })

  it("before this morning's copy has run (DealFlow's new list waits for 7:00): no line, DealFlow not asked", async () => {
    const crm = crmDb()
    const f = fakeDealflow([newest()])
    expect(await readCopyRefusal(ORG, { now: at('2026-10-24T10:00:00Z'), db: crm.db })).toBeNull()
    expect(f.connect).not.toHaveBeenCalled()
  })

  it("the CRM already holds DealFlow's newest list (no new list since): no line", async () => {
    const crm = crmDb()
    fakeDealflow([newest({ run_id: 'run_yesterday', sellers: null })])
    expect(await readCopyRefusal(ORG, { now: NOW, db: crm.db })).toBeNull()
    expect(crm.sent).toEqual([LAST_COPY_SQL]) // nothing counted
  })

  it('a newest list that passes the check (the copy failed for another reason, e.g. DealFlow unreachable): no line', async () => {
    const crm = crmDb({ mapping: [{ mappedLeads: 4, lastCopyLeads: 4 }] })
    fakeDealflow([newest()])
    expect(await readCopyRefusal(ORG, { now: NOW, db: crm.db })).toBeNull()
  })

  it('matches nobody: N is 0', async () => {
    const crm = crmDb({ mapping: [{ mappedLeads: 0, lastCopyLeads: 4 }] })
    fakeDealflow([newest({ sellers: [] })])
    expect(await readCopyRefusal(ORG, { now: NOW, db: crm.db })).toContain('(it reached 0 of your usual 4 sellers)')
  })

  it('a list already too old when the copy ran (the copy skipped it as stale, not as wrong): no line', async () => {
    const crm = crmDb({ lastCopy: [{ slug: 'dealflow-ryan', copiedAt: at('2026-10-20T11:00:04Z'), runId: 'run_old' }] })
    fakeDealflow([newest({ generated_at: '2026-10-22T09:30:00.000Z' })]) // 49.5 h before this morning's copy
    expect(await readCopyRefusal(ORG, { now: NOW, db: crm.db })).toBeNull()
  })

  it('no earlier copy at all (nothing for the Queue to "still show"), or DealFlow has no list: no line', async () => {
    fakeDealflow([newest()])
    expect(await readCopyRefusal(ORG, { now: NOW, db: crmDb({ lastCopy: [{ slug: 'dealflow-ryan', copiedAt: null, runId: null }] }).db })).toBeNull()
    vi.restoreAllMocks()
    fakeDealflow([])
    expect(await readCopyRefusal(ORG, { now: NOW, db: crmDb().db })).toBeNull()
  })

  it('stub mode, or no read-only setting: no line, without connecting to DealFlow', async () => {
    process.env.DEALFLOW_SYNC_STUB = '1'
    let f = fakeDealflow([newest()])
    expect(await readCopyRefusal(ORG, { now: NOW, db: crmDb().db })).toBeNull()
    expect(f.connect).not.toHaveBeenCalled()
    delete process.env.DEALFLOW_SYNC_STUB
    delete process.env.DATABASE_URL_DEALFLOW_RO
    vi.restoreAllMocks()
    f = fakeDealflow([newest()])
    expect(await readCopyRefusal(ORG, { now: NOW, db: crmDb().db })).toBeNull()
    expect(f.connect).not.toHaveBeenCalled()
  })

  it('a failed read: no line, never thrown, and the log line holds a code only (no address, no SQL)', async () => {
    const fail = Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:5432 SELECT "DealFlowDerivedSignal"'), { code: 'ECONNREFUSED' })
    expect(await readCopyRefusal(ORG, { now: NOW, db: crmDb({ fail }).db })).toBeNull()
    expect(warn).toHaveBeenCalledTimes(1)
    const logged = JSON.stringify(warn.mock.calls[0])
    expect(logged).toContain('ECONNREFUSED')
    expect(logged).not.toMatch(/127\.0\.0\.1|postgresql:|SELECT|DealFlowDerivedSignal/)
  })

  it('too slow: no line once the wait is over, and a short log line', async () => {
    const started = Date.now()
    expect(await readCopyRefusal(ORG, { now: NOW, db: crmDb({ hang: true }).db, waitMs: 20 })).toBeNull()
    expect(Date.now() - started).toBeLessThan(150)
    expect(JSON.stringify(warn.mock.calls[0])).toContain('timeout')
  })
})

describe('the Queue page shows the line in both modes', () => {
  const src = readFileSync(join(process.cwd(), 'src/app/queue/page.tsx'), 'utf8')

  it('in its own Suspense boundary keyed by the view (the Queue never waits on DealFlow), next to the nightly notice', () => {
    expect(src).toMatch(
      /<Suspense key=\{`copy:\$\{viewId \?\? ''\}`\} fallback=\{null\}>\s*<MorningCopyNotice organizationId=\{organizationId\} \/>\s*<\/Suspense>/,
    )
    expect(src.match(/<MorningCopyNotice /g)).toHaveLength(1)
  })

  it('above both lists, outside the review-list (calling off) and call-list (calling on) branches', () => {
    const notice = src.indexOf('<MorningCopyNotice ')
    expect(notice).toBeGreaterThan(src.indexOf('<NightlyNoticeBanner />'))
    expect(notice).toBeLessThan(src.indexOf('{reviewMode && ('))
    expect(notice).toBeLessThan(src.indexOf('{review && ('))
    expect(notice).toBeLessThan(src.indexOf('{queue && ('))
  })

  it('renders nothing when there is no refusal (the line itself: tests/integration-local/morning-copy-refusal.test.ts)', async () => {
    process.env.DEALFLOW_SYNC_STUB = '1' // no line, without any database
    expect(await MorningCopyNotice({ organizationId: ORG })).toBeNull()
  })
})

// The line itself never carries anything about a person.
describe('the line holds counts and a date only', () => {
  it('no names, addresses or phone numbers can reach it', () => {
    const text = copyRefusalText({ reached: 12, usual: 1_478, copiedAt: new Date(Date.now() - DAY) }, new Date())
    expect(text.replace(/\d[\d,]*/g, '#')).toMatch(
      /^This morning's ranking from DealFlow looked wrong \(it reached # of your usual # sellers\), so the Queue still shows [A-Z][a-z]{2} #(, #)?'s order\.$/,
    )
  })
})
