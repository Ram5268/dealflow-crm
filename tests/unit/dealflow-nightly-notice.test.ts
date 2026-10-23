import { describe, it, expect, vi, beforeAll, beforeEach, afterEach, afterAll } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import pg from 'pg'
import { renderToStaticMarkup } from 'react-dom/server'
import { assertReadOnlySql, closeDealflowRoPool } from '@/lib/core-data/dealflow-sync/ro-client'
import { NIGHTLY_NOTICE_SQL, NIGHTLY_NOTICE_WAIT_MS, nightlyNoticeText, readNightlyNotice } from '@/lib/core-data/dealflow-sync/nightly-notice'
import { NightlyNoticeBanner } from '@/components/NightlyNoticeBanner'
import { logger } from '@/lib/logger'

// Brief 47 (PR 6): the Queue page's notice when DealFlow's newest nightly,
// within the last 2 days, was refused by a safety check (Brief 47 PR 1's size
// check, or its empty-call-list check) or ran without our values (Brief 44's
// automatic switch-off). The notice itself is an engineering precaution (the
// planner, Brief 47, 2026-10-18). No database here: the read-only pool's
// connect() hands out stand-in clients, the way the health probe's tests do
// (this suite runs with isolate: false, where vi.mock would leak into other
// files). tests/dealflow-nightly-notice.sql.test.ts runs the statement on a
// real Postgres.

const REFUSED = "Last night's matching was stopped by a safety check. You're seeing yesterday's call list."
const ROLLBACK = "Last night's matching ran without DealFlow's values (a safety check turned them off). Ask Claude to look."

// A pooled client that records what it is sent and answers the notice
// statement with `rows`, or throws on it.
function fakeDealflow(answer: { rows?: unknown[]; fail?: Error } = {}) {
  const texts: string[] = []
  const release = vi.fn()
  const connect = vi.spyOn(pg.Pool.prototype, 'connect').mockImplementation((async () => ({
    release,
    on: vi.fn(), // a real pg client's listener methods (roQuery listens for a dropped connection)
    removeListener: vi.fn(),
    query: vi.fn(async (q: string | { text: string }) => {
      const text = typeof q === 'string' ? q : q.text
      texts.push(text)
      if (text === NIGHTLY_NOTICE_SQL) {
        if (answer.fail) throw answer.fail
        return { rows: answer.rows ?? [] }
      }
      return { rows: [] }
    }),
  })) as never)
  return { texts, release, connect }
}

// The server-rendered HTML, with React's escaped apostrophes put back.
const render = async () => {
  const el = await NightlyNoticeBanner()
  return el === null ? null : renderToStaticMarkup(el).replace(/&#x27;/g, "'")
}

// Taken when this file starts, so the restore undoes only its own changes.
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

describe('the notice text for each code (pure)', () => {
  it('refused and rollback get their fixed sentences', () => {
    expect(nightlyNoticeText({ notice: 'refused' })).toBe(REFUSED)
    expect(nightlyNoticeText({ notice: 'rollback' })).toBe(ROLLBACK)
  })

  it('anything else is no notice', () => {
    for (const row of [{ notice: null }, { notice: undefined }, { notice: '' }, { notice: 'REFUSED' }, { notice: 'other' },
      { notice: 1 }, { notice: true }, { notice: 'toString' }, {}, null, undefined]) {
      expect(nightlyNoticeText(row as never), JSON.stringify(row)).toBeNull()
    }
  })
})

describe('the statement', () => {
  it('is one read-only statement the client accepts', () => {
    expect(() => assertReadOnlySql(NIGHTLY_NOTICE_SQL)).not.toThrow()
  })

  it('measures the 2 days in UTC: every now() is (now() AT TIME ZONE \'UTC\')', () => {
    const nows = NIGHTLY_NOTICE_SQL.match(/now\(\)/gi) ?? []
    const utc = NIGHTLY_NOTICE_SQL.match(/\(now\(\) AT TIME ZONE 'UTC'\)/g) ?? []
    expect(nows.length).toBeGreaterThan(0)
    expect(utc.length).toBe(nows.length)
    expect(NIGHTLY_NOTICE_SQL).toContain(`"createdAt" > (now() AT TIME ZONE 'UTC') - interval '2 days'`)
    expect(NIGHTLY_NOTICE_SQL).not.toMatch(/current_timestamp|localtimestamp|current_date/i)
  })

  it('names the four nightly actions it reads, and reads only the rolledBack flag from the details', () => {
    for (const action of ['NIGHTLY_SCORING', 'NIGHTLY_SCORING_REFUSED', 'CALL_QUEUE_BUILD', 'CALL_QUEUE_BUILD_REFUSED']) {
      expect(NIGHTLY_NOTICE_SQL).toContain(`'${action}'`)
    }
    expect(NIGHTLY_NOTICE_SQL.match(/"detailsJson"[^\s,)]*/g)).toEqual([`"detailsJson"->'ourEstimates'->>'rolledBack'`])
    expect(NIGHTLY_NOTICE_SQL).not.toMatch(/"id"|\bid\b/)
  })
})

describe('the banner on the Queue page', () => {
  it('refused: one read inside BEGIN READ ONLY … ROLLBACK, the client goes back, the sentence shows', async () => {
    const f = fakeDealflow({ rows: [{ notice: 'refused' }] })
    const html = await render()
    expect(html).toContain(REFUSED)
    expect(html).toMatch(/^<div role="status"/)
    expect(f.texts).toEqual(['BEGIN READ ONLY', NIGHTLY_NOTICE_SQL, 'ROLLBACK'])
    expect(f.release).toHaveBeenCalledTimes(1)
    expect(warn).not.toHaveBeenCalled()
  })

  it('rollback: the rollback sentence shows', async () => {
    fakeDealflow({ rows: [{ notice: 'rollback' }] })
    const html = await render()
    expect(html).toContain(ROLLBACK)
    expect(html).not.toContain(REFUSED)
  })

  it('a good night (null) or no row: nothing', async () => {
    fakeDealflow({ rows: [{ notice: null }] })
    expect(await render()).toBeNull()
    vi.restoreAllMocks()
    fakeDealflow({ rows: [] })
    expect(await render()).toBeNull()
  })

  it('no DealFlow read-only setting: nothing, without connecting, and a short log line', async () => {
    delete process.env.DATABASE_URL_DEALFLOW_RO
    const f = fakeDealflow({ rows: [{ notice: 'refused' }] })
    expect(await render()).toBeNull()
    expect(f.connect).not.toHaveBeenCalled()
    expect(warn).toHaveBeenCalledTimes(1)
  })

  it('stub mode: nothing, without connecting', async () => {
    process.env.DEALFLOW_SYNC_STUB = '1'
    const f = fakeDealflow({ rows: [{ notice: 'refused' }] })
    expect(await render()).toBeNull()
    expect(f.connect).not.toHaveBeenCalled()
  })

  it('the read throws: nothing, the client is still released, and the log line holds no address or SQL', async () => {
    const fail = Object.assign(new Error('relation "AuditLog" does not exist at 127.0.0.1'), { code: '42P01' })
    const f = fakeDealflow({ fail })
    expect(await render()).toBeNull()
    expect(f.texts).toEqual(['BEGIN READ ONLY', NIGHTLY_NOTICE_SQL, 'ROLLBACK'])
    expect(f.release).toHaveBeenCalledTimes(1)
    expect(warn).toHaveBeenCalledTimes(1)
    const logged = JSON.stringify(warn.mock.calls[0])
    expect(logged).toContain('42P01')
    expect(logged).not.toMatch(/127\.0\.0\.1|postgresql:|dealflow_ro_unit_test|AuditLog|SELECT|NIGHTLY_SCORING/i)
  })

  it('DealFlow cannot be reached: nothing, and the log line holds no address', async () => {
    const refused = Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:9'), { code: 'ECONNREFUSED' })
    vi.spyOn(pg.Pool.prototype, 'connect').mockRejectedValue(refused as never)
    expect(await render()).toBeNull()
    expect(warn).toHaveBeenCalledTimes(1)
    const logged = JSON.stringify(warn.mock.calls[0])
    expect(logged).toContain('ECONNREFUSED')
    expect(logged).not.toMatch(/127\.0\.0\.1|postgresql:|dealflow_ro_unit_test/)
  })

  it('DealFlow answers too slowly: no notice once the wait is over (never the late answer), and a short log line', async () => {
    vi.spyOn(pg.Pool.prototype, 'connect').mockImplementation((async () => ({
      release: vi.fn(),
      on: vi.fn(),
      removeListener: vi.fn(),
      query: vi.fn(async (q: string | { text: string }) => {
        const text = typeof q === 'string' ? q : q.text
        if (text !== NIGHTLY_NOTICE_SQL) return { rows: [] }
        await new Promise((resolve) => setTimeout(resolve, 200))
        return { rows: [{ notice: 'refused' }] }
      }),
    })) as never)
    const started = Date.now()
    expect(await readNightlyNotice(20)).toBeNull()
    expect(Date.now() - started).toBeLessThan(150)
    expect(warn).toHaveBeenCalledTimes(1)
    expect(JSON.stringify(warn.mock.calls[0])).toContain('timeout')
    await new Promise((resolve) => setTimeout(resolve, 250)) // the abandoned read ends without throwing
  })

  it('the default wait is a few seconds, well under the pool\'s 8-second connect timeout', () => {
    expect(NIGHTLY_NOTICE_WAIT_MS).toBeGreaterThanOrEqual(1_000)
    expect(NIGHTLY_NOTICE_WAIT_MS).toBeLessThan(8_000)
  })
})

describe('the Queue page', () => {
  // A view switch is a client transition on the same page, and React holds a
  // transition until an already-shown Suspense boundary resolves: keyed by
  // the view, the new list never waits for DealFlow (independent review, PR 6).
  it('streams the notice in its own Suspense boundary, keyed by the view', () => {
    const src = readFileSync(join(process.cwd(), 'src/app/queue/page.tsx'), 'utf8')
    expect(src).toMatch(/<Suspense key=\{viewId \?\? ''\} fallback=\{null\}>\s*<NightlyNoticeBanner \/>\s*<\/Suspense>/)
  })
})
