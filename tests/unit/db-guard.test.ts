import { describe, it, expect, afterEach, beforeEach } from 'vitest'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { assertTestDatabase, databaseName, isTestDatabase, scriptArgs, LIVE_OVERRIDE_FLAG } from '@/lib/shared/db-guard'
import { mainIsTestDb } from '../setup/live-guard'
import { assertSuite2Database, assertSuite2Environment, prismaMainUrl } from '../setup/suite2-db-guard'

// Brief 41 (H11): the shared live-database guard for tests and scripts.
const LIVE = 'postgresql://u:p@db.invalid:5432/dealflow_crm?sslmode=require'
const PERF = 'postgresql://u:p@db.invalid:5432/dealflow_crm_perf?sslmode=require'
const TEST = 'postgres://u:p@db.invalid/crm_test'

describe('live-database guard', () => {
  it('reads the database name from a URL', () => {
    expect(databaseName(LIVE)).toBe('dealflow_crm')
    expect(databaseName(PERF + '&schema=b41_x')).toBe('dealflow_crm_perf')
    expect(databaseName('')).toBeNull()
    expect(databaseName(undefined)).toBeNull()
    expect(databaseName('not a url')).toBeNull()
    // A path with a "/" isn't one database name (a client may use only the first part).
    expect(databaseName('postgresql://u:p@db.invalid/dealflow_crm/x_test')).toBeNull()
  })

  it('only *_perf and *_test databases count as test databases', () => {
    expect(isTestDatabase(PERF)).toBe(true)
    expect(isTestDatabase(TEST)).toBe(true)
    expect(isTestDatabase(LIVE)).toBe(false)
    expect(isTestDatabase('postgresql://u:p@h/dealflow_perf_backup')).toBe(false)
    expect(isTestDatabase('postgresql://u:p@h/dealflow_crm/x_test')).toBe(false)
    expect(isTestDatabase(undefined)).toBe(false)
  })

  it('refuses a non-test database, and says which', () => {
    expect(() => assertTestDatabase(LIVE, 'gate1-smoke', { argv: [] })).toThrow(/REFUSING: gate1-smoke would use database "dealflow_crm"/)
    expect(() => assertTestDatabase(undefined, 'restore', { argv: [] })).toThrow(/"\(not set\)"/)
    expect(() => assertTestDatabase('nonsense', 'restore', { argv: [] })).toThrow(/"\(unreadable URL\)"/)
    expect(() => assertTestDatabase(PERF, 'x', { argv: [] })).not.toThrow()
    expect(() => assertTestDatabase(TEST, 'x', { argv: [] })).not.toThrow()
  })

  it('--i-mean-live works only where a script opts in; the default (and every test) refuses it', () => {
    const argv = ['node', 'restore.ts', 'b.json', LIVE_OVERRIDE_FLAG]
    expect(() => assertTestDatabase(LIVE, 'restore', { argv, allowOverride: true })).not.toThrow()
    expect(() => assertTestDatabase(LIVE, 'a test helper', { argv })).toThrow(/REFUSING/)
    expect(() => assertTestDatabase(LIVE, 'the test suite', { argv, allowOverride: false })).toThrow(/REFUSING/)
  })

  it('a script reads its own arguments without the flag, wherever it is', () => {
    expect(scriptArgs(['node', 's.ts', LIVE_OVERRIDE_FLAG, 'down'])).toEqual(['down'])
    expect(scriptArgs(['node', 's.ts', 'down', LIVE_OVERRIDE_FLAG])).toEqual(['down'])
    expect(scriptArgs(['node', 's.ts'])).toEqual([])
  })
})

describe('integration-local suites (mainIsTestDb)', () => {
  const saved = process.env.DATABASE_URL_MAIN
  afterEach(() => {
    if (saved === undefined) delete process.env.DATABASE_URL_MAIN
    else process.env.DATABASE_URL_MAIN = saved
  })
  it('unset → skip; a test database → run; a live one → refuse (no override)', () => {
    process.env.DATABASE_URL_MAIN = ''
    expect(mainIsTestDb()).toBe(false)
    process.env.DATABASE_URL_MAIN = PERF
    expect(mainIsTestDb()).toBe(true)
    process.env.DATABASE_URL_MAIN = LIVE
    expect(() => mainIsTestDb()).toThrow(/REFUSING/)
  })
})

// The refusal line a script printed, without the stack trace around it.
const refusal = (out: string) => out.match(/REFUSING:[^\n]*/)?.[0] ?? ''

describe('scripts/assert-test-db.ts (run-isolation-boot.sh)', () => {
  const run = (url: string, ...args: string[]) =>
    spawnSync('node_modules/.bin/tsx', ['scripts/assert-test-db.ts', 'DATABASE_URL_MAIN', 'boot', ...args], {
      env: { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '', NODE_ENV: 'test', DATABASE_URL_MAIN: url },
      encoding: 'utf8',
    })
  // Brief 41.1: the isolation boot migrates and seeds fake fixtures and never
  // passes an override on, so the check takes none and doesn't advertise one.
  it('exits 1 with the reason for a live database, even with --i-mean-live; 0 for a test one', () => {
    const live = run(LIVE)
    expect(live.status).toBe(1)
    expect(refusal(live.stderr)).toMatch(/REFUSING: boot \(DATABASE_URL_MAIN\) would use database "dealflow_crm"/)
    expect(refusal(live.stderr)).not.toContain(LIVE_OVERRIDE_FLAG)
    expect(run(PERF).status).toBe(0)
    expect(run(LIVE, LIVE_OVERRIDE_FLAG).status).toBe(1)
  })
}, 60_000)

// Brief 41.1 (F2): smoke and seed scripts have no real use on the live CRM.
// gate1-smoke deletes the sent-email log's `gmail:<crm-…` messages and
// worker-smoke ticks every live enrollment, so --i-mean-live must not unlock
// them, and their refusal must not suggest it. Each run stops at its guard: the
// URL's host (db.invalid) never resolves, so nothing could connect anyway.
describe('smoke and seed scripts refuse a live database even with --i-mean-live', () => {
  const run = (script: string, ...args: string[]) =>
    spawnSync('node_modules/.bin/tsx', [script, ...args, LIVE_OVERRIDE_FLAG], {
      env: { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '', NODE_ENV: 'test', DATABASE_URL_MAIN: LIVE },
      encoding: 'utf8',
      timeout: 60_000,
    })
  it.each([
    ['scripts/gate1-smoke.ts', 'gate1-smoke'],
    ['scripts/worker-smoke.ts', 'worker-smoke'],
    ['scripts/seed-compliance-fixtures.ts', 'seed-compliance-fixtures'],
    ['scripts/_agentf-visual-seed.ts', '_agentf-visual-seed', 'up'],
  ])('%s', (script, name, ...args) => {
    const r = run(script, ...args)
    expect(r.error).toBeUndefined() // not killed by the timeout
    expect(r.status).toBe(1)
    expect(refusal(r.stderr)).toContain(`REFUSING: ${name} (DATABASE_URL_MAIN) would use database "dealflow_crm"`)
    expect(refusal(r.stderr)).not.toContain(LIVE_OVERRIDE_FLAG)
  }, 90_000)
})

// Brief 41.1 (F11): suite 2 mocks Prisma in every file, but nothing enforced
// it, and Prisma 6 loads DATABASE_URL_MAIN from the checkout's .env on its own
// when the environment doesn't set it. So suite 2 refuses to start on a
// non-test database (tests/setup/suite2-db-guard.ts, its globalSetup).
describe('suite 2 (vitest.agent-d.config.ts) refuses a live database', () => {
  let dir: string
  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'suite2-guard-'))
  })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  it('reads the URL the way Prisma would: the environment (even empty) wins, then .env, then prisma/.env', () => {
    expect(prismaMainUrl({ DATABASE_URL_MAIN: '' }, [`DATABASE_URL_MAIN=${LIVE}`])).toBe('')
    expect(prismaMainUrl({ DATABASE_URL_MAIN: PERF }, [`DATABASE_URL_MAIN=${LIVE}`])).toBe(PERF)
    expect(prismaMainUrl({}, [`DATABASE_URL_MAIN="${LIVE}"`])).toBe(LIVE)
    expect(prismaMainUrl({}, ['OTHER=1', `DATABASE_URL_MAIN=${LIVE}`])).toBe(LIVE)
    expect(prismaMainUrl({}, [])).toBeUndefined()
  })

  it("refuses a live URL from the environment or from the checkout's .env; allows none, an empty one or a test one", () => {
    expect(() => assertSuite2Database({ DATABASE_URL_MAIN: LIVE }, dir)).toThrow(/REFUSING: suite 2/)
    expect(() => assertSuite2Database({}, dir)).not.toThrow()
    writeFileSync(path.join(dir, '.env'), `DATABASE_URL_MAIN="${LIVE}"\n`)
    expect(() => assertSuite2Database({}, dir)).toThrow(/would use database "dealflow_crm"/)
    expect(() => assertSuite2Database({ DATABASE_URL_MAIN: '' }, dir)).not.toThrow()
    expect(() => assertSuite2Database({ DATABASE_URL_MAIN: TEST }, dir)).not.toThrow()
    rmSync(path.join(dir, '.env'))
    mkdirSync(path.join(dir, 'prisma'))
    writeFileSync(path.join(dir, 'prisma', '.env'), `DATABASE_URL_MAIN=${LIVE}\n`)
    let message = ''
    try {
      assertSuite2Database({}, dir)
    } catch (err) {
      message = (err as Error).message
    }
    expect(message).toMatch(/^REFUSING: suite 2/)
    expect(message).toContain('DATABASE_URL_MAIN set empty')
    expect(message).not.toContain(LIVE_OVERRIDE_FLAG)
  })

  it("also checks what Prisma itself loads (the .env recorded at generate time, which may be another checkout's)", async () => {
    // Stand-in for Prisma loading a live .env into the environment.
    const env: Record<string, string | undefined> = {}
    await expect(assertSuite2Environment(env, dir, async () => { env.DATABASE_URL_MAIN = LIVE })).rejects.toThrow(/REFUSING: suite 2/)
    const ok: Record<string, string | undefined> = {}
    await expect(assertSuite2Environment(ok, dir, async () => { ok.DATABASE_URL_MAIN = TEST })).resolves.toBeUndefined()
    // Nothing Prisma loaded is left behind for the suite-2 workers (keys,
    // credentials, send switches), whether the check passes or refuses.
    const clean: Record<string, string | undefined> = { KEEP: 'me' }
    await assertSuite2Environment(clean, dir, async () => { clean.EXTRA = '1'; clean.KEEP = 'changed' })
    expect(clean).toEqual({ KEEP: 'me' })
    const refused: Record<string, string | undefined> = {}
    await expect(assertSuite2Environment(refused, dir, async () => { refused.DATABASE_URL_MAIN = LIVE; refused.TWILIO_AUTH_TOKEN = 'x' })).rejects.toThrow(/REFUSING/)
    expect(refused).toEqual({})
    // A live value already in the environment is refused before Prisma is touched.
    let loaded = false
    await expect(assertSuite2Environment({ DATABASE_URL_MAIN: LIVE }, dir, async () => { loaded = true })).rejects.toThrow(/REFUSING/)
    expect(loaded).toBe(false)
  })

  it('the suite-2 run itself refuses a live DATABASE_URL_MAIN, and runs with a test one', () => {
    const run = (url: string) =>
      spawnSync('node_modules/.bin/vitest', ['run', '--config', 'vitest.agent-d.config.ts', 'src/lib/comms/sms/config.test.ts'], {
        env: { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '', NODE_ENV: 'test', DATABASE_URL_MAIN: url },
        encoding: 'utf8',
        timeout: 120_000,
      })
    const live = run(LIVE)
    expect(live.status).not.toBe(0)
    expect(refusal(live.stdout + live.stderr)).toContain('REFUSING: suite 2')
    expect(run(TEST).status).toBe(0)
  }, 240_000)
})

describe('seed-dev refuses a database name with a "/" (the shared guard)', () => {
  it('refuses .../dealflow_crm/x_perf, which its own *_perf check alone accepted', () => {
    const r = spawnSync('node_modules/.bin/tsx', ['scripts/seed-dev.ts'], {
      env: { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '', NODE_ENV: 'test', DATABASE_URL_PERF: 'postgresql://u:p@db.invalid:5432/dealflow_crm/x_perf' },
      encoding: 'utf8',
      timeout: 60_000,
    })
    expect(r.status).toBe(1)
    expect(refusal(r.stderr)).toContain('REFUSING: seed-dev (DATABASE_URL_PERF) would use database "(unreadable URL)"')
  }, 90_000)
})
