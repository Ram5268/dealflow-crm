import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import type pg from 'pg'
import { makePerfPool, perfConnectionString } from './setup/pg'
import { roQuery, closeDealflowRoPool } from '@/lib/core-data/dealflow-sync/ro-client'

// Brief 50 (PR 11): the DealFlow read-only client's session on a real
// Postgres (open item 6.11). Suite 1: CI's db-suite job runs this on its
// throwaway Postgres (perfConnectionString() refuses anything but *_perf /
// *_test, never DealFlow's). Engineering precautions:
//   • every DealFlow read has a time limit, set on the session itself, so a
//     stuck read ends on the server instead of holding the morning copy (or a
//     lead page) until the platform's own limit;
//   • a connection dropped while a read holds it fails that read, and nothing
//     else: before, pg's 'error' event on the checked-out client had no
//     listener and crashed the process (the reviewer's probe, Brief 41.2 PR F
//     r2: ~/dev/brief41-2/review/scratch/prF/probe/busy-drop.log).
let admin: pg.Pool
let savedEnv: Record<string, string | undefined> = {}
const uncaught: unknown[] = []
const onUncaught = (err: unknown) => {
  uncaught.push(err)
}

beforeAll(async () => {
  savedEnv = { ...process.env }
  await closeDealflowRoPool()
  process.env.DATABASE_URL_DEALFLOW_RO = perfConnectionString()
  admin = makePerfPool(2)
  process.prependListener('uncaughtException', onUncaught)
})

afterAll(async () => {
  process.removeListener('uncaughtException', onUncaught)
  await closeDealflowRoPool()
  for (const key of Object.keys(process.env)) if (!(key in savedEnv)) delete process.env[key]
  Object.assign(process.env, savedEnv)
  await admin?.end()
})

describe('the DealFlow read-only session', () => {
  it('carries a statement time limit and an idle-in-transaction limit, both 60 s', async () => {
    const [s] = await roQuery<{ statement: string; idle: string }>(
      `SELECT current_setting('statement_timeout') AS statement, current_setting('idle_in_transaction_session_timeout') AS idle`,
    )
    expect(s).toEqual({ statement: '1min', idle: '1min' })
  })

  it('a connection dropped mid-read fails that read only: no crash, and the next read works', async () => {
    const marker = `b50_drop_${Date.now()}`
    const read = roQuery(`SELECT pg_sleep(20) AS ${marker}`)
    read.catch(() => undefined) // awaited below
    let pid: number | null = null
    for (let i = 0; i < 100 && pid === null; i += 1) {
      const r = await admin.query<{ pid: number }>(
        `SELECT pid FROM pg_stat_activity WHERE state = 'active' AND query LIKE $1 AND pid <> pg_backend_pid()`,
        [`%AS ${marker}%`],
      )
      pid = r.rows[0]?.pid ?? null
      if (pid === null) await new Promise((resolve) => setTimeout(resolve, 50))
    }
    expect(pid).not.toBeNull()
    await admin.query('SELECT pg_terminate_backend($1)', [pid])
    await expect(read).rejects.toThrow()
    await new Promise((resolve) => setTimeout(resolve, 300)) // let the socket's close events run
    expect(uncaught).toEqual([])
    expect((await roQuery<{ ok: number }>('SELECT 1 AS ok'))[0].ok).toBe(1)
  })
})

// Brief 50 (PR 21), engineering precaution (small tidy-up): one caller can ask
// for a tighter limit than the session's own 60 s default, for its one
// statement only -- and the database, not just the caller, actually stops the
// query. Proved on a real Postgres with pg_sleep as a stand-in for a slow
// DealFlow read: the statement is cancelled around the short limit, far short
// of how long pg_sleep asked to run, and the pooled connection's own 60 s
// default is unaffected afterward (SET LOCAL reverts at ROLLBACK).
describe("roQuery's own, tighter statement time limit", () => {
  it('Postgres itself cancels the statement around the limit, not after pg_sleep finishes', async () => {
    const started = Date.now()
    await expect(roQuery('SELECT pg_sleep(2)', [], { statementTimeoutMs: 150 })).rejects.toThrow(/canceling statement due to statement timeout/)
    expect(Date.now() - started).toBeLessThan(1_500) // well short of the 2 s sleep
  })

  it("doesn't touch the session's own default: a plain read right after still carries the 60 s limit", async () => {
    await expect(roQuery('SELECT pg_sleep(2)', [], { statementTimeoutMs: 100 })).rejects.toThrow()
    const [s] = await roQuery<{ t: string }>(`SELECT current_setting('statement_timeout') AS t`)
    expect(s.t).toBe('1min')
  })

  it('a non-integer or non-positive limit is refused, and the pool keeps working afterward', async () => {
    await expect(roQuery('SELECT 1', [], { statementTimeoutMs: 0 })).rejects.toThrow(/positive integer/)
    await expect(roQuery('SELECT 1', [], { statementTimeoutMs: -5 })).rejects.toThrow(/positive integer/)
    await expect(roQuery('SELECT 1', [], { statementTimeoutMs: 1.5 })).rejects.toThrow(/positive integer/)
    expect((await roQuery<{ n: number }>('SELECT 1 AS n'))[0].n).toBe(1)
  })
})
