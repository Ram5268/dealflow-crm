import { describe, it, expect, vi, beforeAll, beforeEach, afterEach, afterAll } from 'vitest'
import pg from 'pg'
import { roQuery, closeDealflowRoPool } from '@/lib/core-data/dealflow-sync/ro-client'
import { RO_SQL, RUN_INFO_SQL } from '@/lib/core-data/dealflow-sync/sync'
import { logger } from '@/lib/logger'

// Brief 41.2 (PR F), engineering precautions from the Oct 16, 2026 system-map
// review (audit M3: the login behind the CRM's DealFlow setting can write).
// The read-only client used to check only a query's first word. Now every
// statement runs inside BEGIN READ ONLY … ROLLBACK, so Postgres itself refuses
// a write such as `WITH d AS (DELETE …) SELECT …`, and a query holding a second
// statement is refused before anything is sent. No database here: the pool's
// connect() hands out a stand-in client (tests/dealflow-ro-client.readonly.test.ts
// runs the same refusals on a real Postgres in CI).

type Sent = { text: string; values?: unknown; queryMode?: string }

// A pooled client that records what it is sent and, like Postgres, refuses a
// write once it is inside a READ ONLY transaction.
function fakeClient(fail: { on?: RegExp; rollback?: boolean } = {}) {
  const sent: Sent[] = []
  let readOnly = false
  const client = {
    query: vi.fn(async (q: string | Sent, values?: unknown) => {
      const s: Sent = typeof q === 'string' ? { text: q, values } : q
      sent.push(s)
      if (s.text === 'BEGIN READ ONLY') readOnly = true
      if (s.text === 'ROLLBACK') {
        readOnly = false
        if (fail.rollback) throw new Error('connection lost')
      }
      if (fail.on?.test(s.text)) throw new Error('statement failed')
      const write = /\b(insert|update|delete|truncate|drop)\b/i.exec(s.text)
      if (readOnly && write) throw new Error(`cannot execute ${write[1].toUpperCase()} in a read-only transaction`)
      return { rows: [{ ok: 1 }] }
    }),
    release: vi.fn(),
  }
  return { client, sent, texts: () => sent.map((s) => s.text) }
}

// Taken when this file starts, so the restore undoes only its own changes.
let savedEnv: Record<string, string | undefined> = {}
beforeAll(() => {
  savedEnv = { ...process.env }
})
let connect: ReturnType<typeof vi.spyOn>
function useClient(client: ReturnType<typeof fakeClient>['client']) {
  connect = vi.spyOn(pg.Pool.prototype, 'connect').mockResolvedValue(client as never)
}

beforeEach(async () => {
  await closeDealflowRoPool()
  // An address nothing listens on: connect() is replaced, no socket is opened.
  process.env.DATABASE_URL_DEALFLOW_RO = 'postgresql://u:p@127.0.0.1:9/dealflow_ro_unit_test'
})
afterEach(async () => {
  vi.restoreAllMocks()
  await closeDealflowRoPool()
})
afterAll(() => {
  for (const key of Object.keys(process.env)) if (!(key in savedEnv)) delete process.env[key]
  Object.assign(process.env, savedEnv)
})

describe('roQuery runs every statement inside BEGIN READ ONLY … ROLLBACK', () => {
  it('a read: BEGIN READ ONLY, the statement, ROLLBACK, then the client goes back to the pool', async () => {
    const f = fakeClient()
    useClient(f.client)
    expect(await roQuery('SELECT 1 AS ok')).toEqual([{ ok: 1 }])
    expect(f.texts()).toEqual(['BEGIN READ ONLY', 'SELECT 1 AS ok', 'ROLLBACK'])
    expect(f.client.release).toHaveBeenCalledTimes(1)
    expect(f.client.release.mock.calls[0][0]).toBeFalsy() // returned, not destroyed
  })

  it('the statement goes with its parameters over the extended protocol, where Postgres refuses a second command', async () => {
    const f = fakeClient()
    useClient(f.client)
    await roQuery('SELECT $1::text AS v', ['x'])
    expect(f.sent[1]).toEqual({ text: 'SELECT $1::text AS v', values: ['x'], queryMode: 'extended' })
  })

  it('a failing statement is still rolled back, its client released, and the error reaches the caller', async () => {
    const f = fakeClient({ on: /FROM nowhere/ })
    useClient(f.client)
    await expect(roQuery('SELECT * FROM nowhere')).rejects.toThrow('statement failed')
    expect(f.texts()).toEqual(['BEGIN READ ONLY', 'SELECT * FROM nowhere', 'ROLLBACK'])
    expect(f.client.release).toHaveBeenCalledTimes(1)
  })

  it('if BEGIN READ ONLY fails, the statement is never sent', async () => {
    const f = fakeClient({ on: /^BEGIN/ })
    useClient(f.client)
    await expect(roQuery('SELECT 1')).rejects.toThrow('statement failed')
    expect(f.texts()).not.toContain('SELECT 1')
    expect(f.client.release).toHaveBeenCalledTimes(1)
  })

  it('a client whose ROLLBACK fails is destroyed instead of going back to the pool', async () => {
    const f = fakeClient({ rollback: true })
    useClient(f.client)
    expect(await roQuery('SELECT 1')).toEqual([{ ok: 1 }])
    expect(f.client.release).toHaveBeenCalledTimes(1)
    expect(f.client.release).toHaveBeenCalledWith(true)
  })

  it('a WITH … DELETE gets past the first-word check but only ever runs inside the read-only transaction, which refuses it', async () => {
    const f = fakeClient()
    useClient(f.client)
    const sql = 'WITH d AS (DELETE FROM "Match" RETURNING 1) SELECT count(*) FROM d'
    await expect(roQuery(sql)).rejects.toThrow(/read-only transaction/)
    expect(f.texts()).toEqual(['BEGIN READ ONLY', sql, 'ROLLBACK'])
    expect(f.client.release).toHaveBeenCalledTimes(1)
  })
})

describe('roQuery refuses before connecting', () => {
  it('anything but SELECT/WITH (the first-word check, kept)', async () => {
    useClient(fakeClient().client)
    for (const s of ['UPDATE "Match" SET score = 0', 'DELETE FROM "Match"', 'insert into x values (1)', 'DROP TABLE "Match"', 'BEGIN', 'COMMIT', '']) {
      await expect(roQuery(s), s).rejects.toThrow(/only permits SELECT\/WITH/)
    }
    expect(connect).not.toHaveBeenCalled()
  })

  it('more than one statement: a COMMIT could end the read-only transaction before the next one', async () => {
    const f = fakeClient()
    useClient(f.client)
    const multi = [
      'SELECT 1; DELETE FROM "Match"',
      'SELECT 1; COMMIT; DELETE FROM "Match"',
      'select 1;select 2',
      'WITH x AS (SELECT 1) SELECT * FROM x; DROP TABLE "Match"',
      'SELECT 1;\n-- a comment\nDELETE FROM "Match"',
      'SELECT 1;;',
      // A ; that only looks hidden inside a string, a name or a comment.
      `SELECT '--'; DELETE FROM "Match"`,
      'SELECT 1 AS "/*"; DELETE FROM "Match"',
      String.raw`SELECT E'\''; DELETE FROM "Match"; --'`,
      `SELECT $$'$$; DELETE FROM "Match"; SELECT $$'$$`,
      'SELECT $q$ $$ $q$; DELETE FROM "Match"',
      // Postgres ends a -- comment at \r too, and carries an E'…' string on
      // into a '…' on a later line, backslashes included.
      'SELECT 1 --c\r; DELETE FROM "Match"',
      'SELECT 1; --c\rDELETE FROM "Match"',
      String.raw`SELECT E'x'` + "\n" + String.raw`'\''; COMMIT; DELETE FROM "Match"; --'`,
      String.raw`SELECT E'x' -- note` + "\n" + String.raw`'\''; DELETE FROM "Match"; --'`,
      // Unclosed quotes or comments: where the statement ends can't be told.
      `SELECT 'unclosed; DELETE FROM "Match"`,
      'SELECT "unclosed; DELETE FROM x',
      'SELECT 1 /* unclosed; DELETE FROM x',
      'SELECT $$unclosed; DELETE FROM x',
    ]
    for (const s of multi) await expect(roQuery(s), s).rejects.toThrow(/one statement/)
    expect(connect).not.toHaveBeenCalled()
    expect(f.sent).toEqual([]) // refused before any BEGIN
  })

  it('one statement passes, whatever its quotes and comments hold, and so do the sync queries', async () => {
    useClient(fakeClient().client)
    const single = [
      `SELECT ';' AS semi`,
      `SELECT 'it''s; fine'`,
      String.raw`SELECT E'it\'s; fine'`,
      'SELECT "a;b" FROM t',
      'SELECT $$;$$, $tag$ ; $$ $tag$',
      'SELECT $1::text',
      'SELECT 1 -- a comment; with a semicolon',
      'SELECT 1 /* a; /* nested; */ comment */',
      'SELECT 1 -- a comment; ended by a CR\r\n',
      String.raw`SELECT E'a\'b', 'c'`,
      'SELECT 1;',
      'SELECT 1; -- a trailing comment',
      'SELECT 1 ; /* trailing */ ',
      RO_SQL, // its comment holds a ;
      RUN_INFO_SQL,
    ]
    for (const s of single) await expect(roQuery(s), s).resolves.toEqual([{ ok: 1 }])
    expect(connect).toHaveBeenCalledTimes(single.length)
  })
})

describe('the pool survives a dropped idle connection', () => {
  it("an 'error' from the pool (an idle connection reset) is logged briefly instead of crashing", async () => {
    const f = fakeClient()
    useClient(f.client)
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => undefined)
    await roQuery('SELECT 1') // creates the pool
    const pool = connect.mock.contexts[0] as pg.Pool
    // What pg-pool emits when the server drops an idle client: the error, with
    // that client (and its connection settings) attached.
    const reset = Object.assign(new Error('Connection terminated unexpectedly'), {
      client: { connectionParameters: { password: 'p', host: '127.0.0.1' } },
    })
    expect(() => pool.emit('error', reset, reset.client)).not.toThrow()
    expect(warn).toHaveBeenCalledTimes(1)
    const logged = JSON.stringify(warn.mock.calls[0])
    expect(logged).toContain('Connection terminated unexpectedly')
    expect(logged).not.toMatch(/127\.0\.0\.1|postgresql:|password/)
  })
})
