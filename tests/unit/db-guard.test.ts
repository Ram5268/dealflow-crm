import { describe, it, expect, afterEach } from 'vitest'
import { spawnSync } from 'node:child_process'
import { assertTestDatabase, databaseName, isTestDatabase, scriptArgs, LIVE_OVERRIDE_FLAG } from '@/lib/shared/db-guard'
import { mainIsTestDb } from '../setup/live-guard'

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

describe('scripts/assert-test-db.ts (run-isolation-boot.sh)', () => {
  const run = (url: string, ...args: string[]) =>
    spawnSync('node_modules/.bin/tsx', ['scripts/assert-test-db.ts', 'DATABASE_URL_MAIN', 'boot', ...args], {
      env: { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '', DATABASE_URL_MAIN: url },
      encoding: 'utf8',
    })
  it('exits 1 with the reason for a live database, 0 for a test one or with --i-mean-live', () => {
    const live = run(LIVE)
    expect(live.status).toBe(1)
    expect(live.stderr).toMatch(/REFUSING: boot \(DATABASE_URL_MAIN\) would use database "dealflow_crm"/)
    expect(run(PERF).status).toBe(0)
    expect(run(LIVE, LIVE_OVERRIDE_FLAG).status).toBe(0)
  })
}, 60_000)
