import { describe, it, expect, afterAll, afterEach, beforeAll, beforeEach } from 'vitest'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { assertTestDatabase, databaseName, isTestDatabase, scriptArgs, LIVE_OVERRIDE_FLAG } from '@/lib/shared/db-guard'
import { checkSuite1Databases, databaseSuitesRequired, mainIsTestDb } from '../setup/live-guard'
import { assertSuite2Database, prismaMainUrl } from '../setup/suite2-db-guard'

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
  it('unset on a local run → skip; a test database → run; a live one → refuse (no override)', () => {
    expect(mainIsTestDb({ DATABASE_URL_MAIN: '' })).toBe(false)
    expect(mainIsTestDb({})).toBe(false)
    expect(mainIsTestDb({ CI: 'false' })).toBe(false)
    expect(mainIsTestDb({ DATABASE_URL_MAIN: PERF })).toBe(true)
    expect(() => mainIsTestDb({ DATABASE_URL_MAIN: LIVE })).toThrow(/REFUSING/)
  })

  // Brief 50 (6.14): a CI edit that dropped DATABASE_URL_MAIN used to turn the
  // integration-local suites off without a word while CI stayed green.
  it('in CI (CI=true, or CRM_TEST_DB_REQUIRED=1) a missing DATABASE_URL_MAIN fails instead of skipping', () => {
    for (const env of [{ CI: 'true' }, { CI: '1' }, { CRM_TEST_DB_REQUIRED: '1' }, { CI: 'true', DATABASE_URL_MAIN: '' }]) {
      expect(databaseSuitesRequired(env)).toBe(true)
      expect(() => mainIsTestDb(env)).toThrow(/DATABASE_URL_MAIN is not set/)
    }
    expect(databaseSuitesRequired({})).toBe(false)
    expect(databaseSuitesRequired({ CI: 'false', CRM_TEST_DB_REQUIRED: '0' })).toBe(false)
    expect(mainIsTestDb({ CI: 'true', DATABASE_URL_MAIN: TEST })).toBe(true)
    // The live-database guard is as strict as ever, in CI or not.
    expect(() => mainIsTestDb({ CI: 'true', DATABASE_URL_MAIN: LIVE })).toThrow(/REFUSING/)
  })
})

// Brief 50 (6.14): suite 1's globalSetup checks both settings before anything
// touches a database. In CI a missing one stops the run with a plain message;
// a local run without DATABASE_URL_MAIN still works, with a loud warning.
describe('suite 1 database settings (globalSetup)', () => {
  it('in CI, a missing DATABASE_URL_PERF or DATABASE_URL_MAIN stops the run and says how to fix it', () => {
    expect(() => checkSuite1Databases({ CI: 'true', DATABASE_URL_PERF: TEST })).toThrow(
      /DATABASE_URL_MAIN is not set[\s\S]*must run, not skip[\s\S]*\.github\/workflows\/ci\.yml/,
    )
    expect(() => checkSuite1Databases({ CI: 'true', DATABASE_URL_MAIN: TEST })).toThrow(/DATABASE_URL_PERF is not set/)
    expect(() => checkSuite1Databases({ CRM_TEST_DB_REQUIRED: '1', DATABASE_URL_PERF: '', DATABASE_URL_MAIN: TEST })).toThrow(/DATABASE_URL_PERF is not set/)
    expect(checkSuite1Databases({ CI: 'true', DATABASE_URL_PERF: TEST, DATABASE_URL_MAIN: PERF })).toBeNull()
  })

  it('locally, without DATABASE_URL_PERF it still stops; without DATABASE_URL_MAIN it warns loudly and goes on', () => {
    expect(() => checkSuite1Databases({})).toThrow(/DATABASE_URL_PERF is not set/)
    expect(() => checkSuite1Databases({ DATABASE_URL_PERF: 'not a url' })).toThrow(/DATABASE_URL_PERF is not set/)
    const warning = checkSuite1Databases({ DATABASE_URL_PERF: TEST })
    expect(warning).toMatch(/WARNING: DATABASE_URL_MAIN is not set/)
    expect(warning).toMatch(/\d+ test files in tests\/integration-local will be SKIPPED/)
    expect(checkSuite1Databases({ DATABASE_URL_PERF: TEST, DATABASE_URL_MAIN: TEST })).toBeNull()
  })

  it('a non-test database is refused for either setting, in CI or not', () => {
    for (const ci of [{}, { CI: 'true' }]) {
      expect(() => checkSuite1Databases({ ...ci, DATABASE_URL_PERF: LIVE, DATABASE_URL_MAIN: TEST })).toThrow(/REFUSING: the test suite \(DATABASE_URL_PERF\)/)
      expect(() => checkSuite1Databases({ ...ci, DATABASE_URL_PERF: TEST, DATABASE_URL_MAIN: LIVE })).toThrow(/REFUSING/)
    }
  })

  // The real run, as CI would start it with DATABASE_URL_MAIN deleted from
  // ci.yml: it stops in globalSetup, before any schema push or connection. The
  // made-up host (db.invalid) never resolves, so nothing could connect anyway.
  it('the real suite-1 run in CI without DATABASE_URL_MAIN fails before touching a database', () => {
    const r = spawnSync('node_modules/.bin/vitest', ['run', 'tests/unit/known-drift.test.ts'], {
      env: {
        PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '', NODE_ENV: 'test', CI: 'true',
        DATABASE_URL_PERF: 'postgresql://u:p@db.invalid:5432/crm_test', VITE_CONFIG_NATIVE_IGNORE_WARNING: 'true',
      },
      encoding: 'utf8',
      timeout: 120_000,
    })
    const out = r.stdout + r.stderr
    expect(r.status).not.toBe(0)
    expect(out).toContain('DATABASE_URL_MAIN is not set')
    expect(out).not.toMatch(/prisma db push|Can't reach database server/)
  }, 180_000)
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

// Brief 50 (6.14): this check used to be tested with a stand-in for Prisma's
// own .env loading (the real loading was only checked by hand). These tests
// run the real thing: a Prisma client generated in a temporary "other
// checkout" records that checkout's .env, and a child process runs suite 2's
// check with its real loader on that client. The .env holds made-up addresses
// only (host db.invalid, which never resolves); nothing connects.
describe("suite 2's check of what Prisma itself loads (a real generated client)", () => {
  const REPO = process.cwd()
  let tmp: string
  let here: string // the checkout suite 2 runs in: no .env of its own
  let otherEnv: string // the other checkout's .env, recorded by `prisma generate`
  let client: string

  beforeAll(() => {
    tmp = mkdtempSync(path.join(tmpdir(), 'suite2-prisma-env-'))
    symlinkSync(path.join(REPO, 'node_modules'), path.join(tmp, 'node_modules'), 'dir')
    const other = path.join(tmp, 'other-checkout')
    mkdirSync(path.join(other, 'prisma'), { recursive: true })
    writeFileSync(path.join(other, 'package.json'), '{ "name": "other-checkout", "private": true }\n')
    writeFileSync(
      path.join(other, 'prisma', 'schema.prisma'),
      'generator client {\n  provider = "prisma-client-js"\n  output   = "../client"\n}\n\n' +
        'datasource db {\n  provider = "postgresql"\n  url      = env("DATABASE_URL_MAIN")\n}\n\n' +
        'model Probe {\n  id Int @id\n}\n',
    )
    otherEnv = path.join(other, '.env')
    writeFileSync(otherEnv, `DATABASE_URL_MAIN="${LIVE}"\n`)
    here = path.join(tmp, 'this-checkout')
    mkdirSync(here)
    const gen = spawnSync(path.join(REPO, 'node_modules/.bin/prisma'), ['generate', '--schema', 'prisma/schema.prisma'], {
      cwd: other,
      env: { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '', PRISMA_HIDE_UPDATE_MESSAGE: '1', CHECKPOINT_DISABLE: '1' },
      encoding: 'utf8',
      timeout: 120_000,
    })
    expect(gen.status, gen.stdout + gen.stderr).toBe(0)
    client = path.join(other, 'client', 'index.js')
    // What makes this the real case: the generated client points at the
    // other checkout's .env, wherever the client is used from.
    expect(readFileSync(client, 'utf8')).toMatch(/"rootEnvPath": "\.\.\/\.env"/)
    // The probe: suite 2's check, with its own loader on that client.
    writeFileSync(
      path.join(tmp, 'probe.mts'),
      [
        `import { databaseName } from ${JSON.stringify(path.join(REPO, 'src/lib/shared/db-guard.ts'))}`,
        `import { assertSuite2Environment, loadPrismaEnv } from ${JSON.stringify(path.join(REPO, 'tests/setup/suite2-db-guard.ts'))}`,
        'const [root, client] = process.argv.slice(2)',
        'const out: Record<string, unknown> = { loaderRan: false }',
        'try {',
        '  await assertSuite2Environment(process.env, root, async () => {',
        '    await loadPrismaEnv(client)',
        '    out.loaderRan = true',
        '    out.loadedDatabase = databaseName(process.env.DATABASE_URL_MAIN)',
        "    out.loadedSecret = 'OTHER_CHECKOUT_SECRET' in process.env",
        '  })',
        "  out.result = 'allowed'",
        '} catch (err) {',
        '  out.result = (err as Error).message',
        '}',
        "out.leftBehind = ['DATABASE_URL_MAIN', 'OTHER_CHECKOUT_SECRET'].filter((k) => k in process.env)",
        "console.log('PROBE ' + JSON.stringify(out))",
        '',
      ].join('\n'),
    )
  }, 180_000)
  afterAll(() => {
    if (tmp) rmSync(tmp, { recursive: true, force: true })
  })

  const probe = (envFile: string, env: Record<string, string> = {}) => {
    writeFileSync(otherEnv, envFile)
    const r = spawnSync(path.join(REPO, 'node_modules/.bin/tsx'), [path.join(tmp, 'probe.mts'), here, client], {
      env: { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '', ...env },
      encoding: 'utf8',
      timeout: 60_000,
    })
    const line = r.stdout.split('\n').find((l) => l.startsWith('PROBE '))
    expect(line, r.stdout + r.stderr).toBeDefined()
    return JSON.parse(line!.slice('PROBE '.length)) as {
      result: string
      loaderRan: boolean
      loadedDatabase?: string | null
      loadedSecret?: boolean
      leftBehind: string[]
    }
  }

  it("refuses a live URL that only Prisma's own loading finds (the other checkout's .env), and leaves nothing behind", () => {
    const out = probe(`DATABASE_URL_MAIN="${LIVE}"\nOTHER_CHECKOUT_SECRET=from-the-other-checkout\n`)
    expect(out.loaderRan).toBe(true)
    expect(out.loadedDatabase).toBe('dealflow_crm')
    expect(out.result).toMatch(/^REFUSING: suite 2 .*would use database "dealflow_crm"/)
    expect(out.result).toContain('DATABASE_URL_MAIN set empty')
    expect(out.result).not.toContain(LIVE_OVERRIDE_FLAG)
    expect(out.leftBehind).toEqual([])
  }, 90_000)

  it('allows a test database from that .env, and removes everything Prisma loaded afterwards', () => {
    const out = probe(`DATABASE_URL_MAIN="${TEST}"\nOTHER_CHECKOUT_SECRET=from-the-other-checkout\n`)
    expect(out.result).toBe('allowed')
    expect(out.loadedDatabase).toBe('crm_test') // Prisma really loaded the file when the client was constructed
    expect(out.loadedSecret).toBe(true)
    expect(out.leftBehind).toEqual([])
  }, 90_000)

  it('DATABASE_URL_MAIN set empty (how suite 2 is run) wins over that .env, as Prisma never overrides it', () => {
    const out = probe(`DATABASE_URL_MAIN="${LIVE}"\nOTHER_CHECKOUT_SECRET=from-the-other-checkout\n`, { DATABASE_URL_MAIN: '' })
    expect(out.result).toBe('allowed')
    expect(out.loaderRan).toBe(true)
    expect(out.loadedDatabase).toBeNull()
    expect(out.loadedSecret).toBe(true)
    expect(out.leftBehind).toEqual(['DATABASE_URL_MAIN']) // the empty one it started with; the secret is gone
  }, 90_000)

  it('a live URL already in the environment is refused before Prisma is touched', () => {
    const out = probe(`DATABASE_URL_MAIN="${TEST}"\n`, { DATABASE_URL_MAIN: LIVE })
    expect(out.result).toMatch(/^REFUSING: suite 2/)
    expect(out.loaderRan).toBe(false)
  }, 90_000)
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
