import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import type pg from 'pg'
import { makePerfPool, perfConnectionString } from './setup/pg'
import { roQuery, closeDealflowRoPool } from '@/lib/core-data/dealflow-sync/ro-client'

// Brief 41.2 (PR F), engineering precautions from the Oct 16, 2026 system-map
// review (audit M3). Suite 1: CI's db-suite job runs this on its throwaway
// Postgres. It points the DealFlow read-only client at that test database
// (perfConnectionString() refuses anything but *_perf / *_test, never
// DealFlow's) and works on a scratch table of its own, dropped afterwards.
// It proves that Postgres, not just the client's text check, refuses a write
// sent through the client.
const TABLE = `ro_guard_${Date.now()}`
let admin: pg.Pool
let savedEnv: Record<string, string | undefined> = {}

const rowCount = async () => (await admin.query(`SELECT count(*)::int AS n FROM "${TABLE}"`)).rows[0].n

beforeAll(async () => {
  savedEnv = { ...process.env }
  await closeDealflowRoPool()
  process.env.DATABASE_URL_DEALFLOW_RO = perfConnectionString()
  admin = makePerfPool(2)
  await admin.query(`CREATE TABLE "${TABLE}" (id int PRIMARY KEY)`)
  await admin.query(`INSERT INTO "${TABLE}" (id) VALUES (1), (2)`)
})

afterAll(async () => {
  await closeDealflowRoPool()
  for (const key of Object.keys(process.env)) if (!(key in savedEnv)) delete process.env[key]
  Object.assign(process.env, savedEnv)
  await admin?.query(`DROP TABLE IF EXISTS "${TABLE}"`)
  await admin?.end()
})

describe('the DealFlow read-only client on a real Postgres', () => {
  it('reads through the read-only transaction', async () => {
    expect(await roQuery(`SELECT id FROM "${TABLE}" ORDER BY id`)).toEqual([{ id: 1 }, { id: 2 }])
    expect(await roQuery(`SELECT id FROM "${TABLE}" WHERE id = $1`, [2])).toEqual([{ id: 2 }])
    expect(await roQuery('SELECT 1 AS one;')).toEqual([{ one: 1 }]) // a trailing ; is fine
  })

  it('a statement cannot switch its transaction back to read-write', async () => {
    await expect(roQuery(`SELECT set_config('transaction_read_only', 'off', true)`)).rejects.toThrow(/read-write mode/)
  })

  it('Postgres refuses WITH d AS (DELETE … RETURNING 1) SELECT …, and nothing is deleted', async () => {
    await expect(roQuery(`WITH d AS (DELETE FROM "${TABLE}" RETURNING 1) SELECT count(*) FROM d`)).rejects.toThrow(
      /read-only transaction/
    )
    expect(await rowCount()).toBe(2)
  })

  it('a second statement never runs, so a COMMIT cannot end the read-only transaction early', async () => {
    await expect(roQuery(`SELECT 1; COMMIT; DELETE FROM "${TABLE}"`)).rejects.toThrow(/one statement/)
    expect(await rowCount()).toBe(2)
  })

  it('the pooled connection is read-only again for the next query', async () => {
    await expect(roQuery(`WITH d AS (DELETE FROM "${TABLE}" RETURNING 1) SELECT count(*) FROM d`)).rejects.toThrow()
    await expect(roQuery(`WITH u AS (UPDATE "${TABLE}" SET id = id + 10 RETURNING 1) SELECT count(*) FROM u`)).rejects.toThrow(
      /read-only transaction/
    )
    expect((await admin.query(`SELECT max(id)::int AS m FROM "${TABLE}"`)).rows[0].m).toBe(2)
  })

  it('the extended protocol the client uses refuses two commands on its own (the backstop to the text check)', async () => {
    const twoCommands = { text: `SELECT 1; DELETE FROM "${TABLE}"`, queryMode: 'extended' }
    await expect(admin.query(twoCommands)).rejects.toThrow(/multiple commands/)
    expect(await rowCount()).toBe(2)
  })
})
