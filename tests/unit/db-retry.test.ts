import { describe, it, expect } from 'vitest'
import { spawnSync } from 'node:child_process'
import path from 'node:path'
import {
  CONNECTION_ERROR,
  DB_RETRY_LOG_FILE,
  DB_TEST_RETRY,
  isConnectionError,
  redactDatabaseHosts,
  withConnectionRetry,
} from '../setup/db-retry'

// Brief 50 (6.14): the shared Railway perf database drops connections at times.
// Suite 1 retries only connection-level errors, a fixed small number of times,
// and logs every retry; anything else (an assertion above all) is never retried.
// Every address here is made up (db.invalid never resolves).

const prismaInitError = (errorCode: string, message: string) =>
  Object.assign(new Error(message), { name: 'PrismaClientInitializationError', errorCode })
const prismaRequestError = (code: string, message: string) =>
  Object.assign(new Error(message), { name: 'PrismaClientKnownRequestError', code })
const assertionError = (message: string) => Object.assign(new Error(message), { name: 'AssertionError' })

const DROPPED = [
  prismaInitError('P1001', "Can't reach database server at `db.invalid:5432`\n\nPlease make sure your database server is running at `db.invalid:5432`."),
  prismaInitError('P1002', 'The database server at `db.invalid:5432` was reached but timed out.'),
  prismaRequestError('P1017', 'Server has closed the connection.'),
  prismaRequestError('P2024', 'Timed out fetching a new connection from the connection pool. (Current connection pool timeout: 10, connection limit: 5)'),
  new Error('\nInvalid `prisma.lead.count()` invocation:\n\n\nError in PostgreSQL connection: Error { kind: Closed, cause: None }'),
  new Error('Connection terminated unexpectedly'),
  new Error('Connection terminated due to connection timeout'),
  new Error('timeout exceeded when trying to connect'),
  Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' }),
  Object.assign(new Error('terminating connection due to administrator command'), { code: '57P01' }),
]

const NOT_DROPPED: unknown[] = [
  assertionError('expected 3 to be 4 // Object.is equality'),
  // An assertion that merely mentions a dropped connection is still an assertion.
  new Error("expected 'ok' to contain 'Can't reach database server'"),
  assertionError("expected [Function] to throw error including 'Connection terminated unexpectedly'"),
  prismaRequestError('P2002', 'Unique constraint failed on the fields: (`mojoId`)'),
  new Error('Test timed out in 90000ms.'),
  new SyntaxError('Unexpected token'),
  new Error('REFUSING: the test suite (DATABASE_URL_PERF) would use database "dealflow_crm".'),
  'Connection terminated unexpectedly', // not an Error object
  null,
  undefined,
]

describe('which errors count as a dropped database connection', () => {
  it.each(DROPPED.map((e) => [e.message.split('\n').find(Boolean)!, e]))('retried: %s', (_name, err) => {
    expect(isConnectionError(err)).toBe(true)
  })

  it.each(NOT_DROPPED.map((e) => [String(e instanceof Error ? e.message : e), e]))('never retried: %s', (_name, err) => {
    expect(isConnectionError(err)).toBe(false)
  })

  it("suite 1's retry condition (a RegExp on the failed test's message) agrees", () => {
    for (const err of DROPPED) expect(CONNECTION_ERROR.test(err.message)).toBe(true)
    for (const err of NOT_DROPPED) if (err instanceof Error) expect(CONNECTION_ERROR.test(err.message)).toBe(false)
  })

  it('log lines never carry a database address', () => {
    const text = redactDatabaseHosts(
      "Can't reach database server at `db.invalid:5432`\n" +
        'Datasource "db": PostgreSQL database "x_test", schema "public" at "db.invalid:5432"\n' +
        'postgresql://u:secret@db.invalid:5432/x_test?sslmode=require',
    )
    expect(text).not.toContain('db.invalid')
    expect(text).not.toContain('secret')
    expect(text).toContain("Can't reach database server at <db host>")
  })
})

describe('withConnectionRetry (scripts and setup steps outside a test body)', () => {
  it('a fake flaky connection: two drops, then the answer, with one log line per retry', async () => {
    let calls = 0
    const lines: string[] = []
    const flaky = async () => {
      calls += 1
      if (calls <= 2) throw prismaInitError('P1001', "Can't reach database server at `db.invalid:5432`")
      return 'rows'
    }
    await expect(withConnectionRetry('a flaky query', flaky, { delayMs: 0, log: (l) => lines.push(l) })).resolves.toBe('rows')
    expect(calls).toBe(3)
    expect(lines).toHaveLength(2)
    expect(lines[0]).toMatch(/^\[db-retry\] a flaky query: the database connection dropped \(Can't reach database server at <db host>\); retry 1 of 2/)
    expect(lines[1]).toMatch(/retry 2 of 2/)
    expect(lines.join('\n')).not.toContain('db.invalid')
  })

  it('an assertion failure is thrown at once, never retried', async () => {
    let calls = 0
    const lines: string[] = []
    const failing = assertionError('expected 3 to be 4')
    await expect(
      withConnectionRetry('an assertion', async () => {
        calls += 1
        throw failing
      }, { delayMs: 0, log: (l) => lines.push(l) }),
    ).rejects.toBe(failing)
    expect(calls).toBe(1)
    expect(lines).toEqual([])
  })

  it('a database that stays down: 1 try + 2 retries, then the last error', async () => {
    let calls = 0
    const lines: string[] = []
    const last = new Error('Connection terminated unexpectedly')
    await expect(
      withConnectionRetry('a dead database', async () => {
        calls += 1
        throw calls === 3 ? last : new Error('Connection terminated unexpectedly')
      }, { delayMs: 0, log: (l) => lines.push(l) }),
    ).rejects.toBe(last)
    expect(calls).toBe(3)
    expect(lines).toHaveLength(2)
  })
})

describe("suite 1's test retry (vitest.config.ts)", () => {
  it('retries a failed test only for a dropped connection, at most twice, and logs each retry', async () => {
    // A non-literal import: tsc leaves vitest.config.ts out on purpose.
    const configFile = path.join(process.cwd(), 'vitest.config.ts')
    const config = ((await import(configFile)) as { default: { test?: { retry?: unknown; setupFiles?: unknown } } }).default
    expect(config.test?.retry).toEqual(DB_TEST_RETRY)
    expect(DB_TEST_RETRY).toMatchObject({ count: 2 })
    expect(config.test?.setupFiles).toContain(DB_RETRY_LOG_FILE)
  })

  // The real vitest runner with suite 1's retry settings, on a fake flaky
  // connection (tests/setup/fixtures/db-retry.fixture.ts, not part of any suite).
  it('the real runner: a dropped connection passes on retry; an assertion fails once; a dead database gives up', () => {
    const r = spawnSync('node_modules/.bin/vitest', ['run', '--config', 'tests/setup/fixtures/db-retry.vitest.config.ts'], {
      env: { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '', NODE_ENV: 'test', VITE_CONFIG_NATIVE_IGNORE_WARNING: 'true', NO_COLOR: '1' },
      encoding: 'utf8',
      timeout: 120_000,
    })
    const out = r.stdout + r.stderr
    expect(r.status, out).toBe(1) // two of the three fixture tests fail
    expect(out).toMatch(/Tests\s+2 failed \| 1 passed/)
    // The flaky connection: dropped once, logged, then passed.
    expect(out).toContain('[db-retry] "a query whose connection drops once": the database connection dropped')
    expect(out).toContain('retry 1 of 2')
    expect(out).toContain('flaky attempt 2')
    expect(out).not.toContain('flaky attempt 3')
    // A real assertion failure: one attempt, no retry, no retry log.
    expect(out).toContain('assertion attempt 1')
    expect(out).not.toContain('assertion attempt 2')
    expect(out).not.toMatch(/\[db-retry\] "a real assertion failure"/)
    // A database that stays down: 1 + 2 attempts, then it fails, saying so.
    expect(out).toContain('down attempt 3')
    expect(out).not.toContain('down attempt 4')
    expect(out).toContain('[db-retry] "a database that stays down": the database connection dropped')
    expect(out).toContain('no retries left')
    expect(out).not.toContain('db.invalid')
  }, 180_000)
})
