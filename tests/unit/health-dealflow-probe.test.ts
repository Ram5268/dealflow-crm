import { describe, it, expect, vi, beforeAll, beforeEach, afterEach, afterAll } from 'vitest'
import pg from 'pg'
import { closeDealflowRoPool } from '@/lib/core-data/dealflow-sync/ro-client'
import { getHealth } from '@/lib/shared/health'

// Brief 41.2 (PR F), engineering precautions (Oct 16, 2026 system-map review):
// /api/core-data/health's DealFlow probe now goes through the read-only client,
// so it runs inside BEGIN READ ONLY … ROLLBACK and gives its pooled client back.
// It used to take a raw client and never release it (known issue M2), so a few
// health checks could use up the pool of 4 that the 7:00 am sync needs too.
// No database: the pool's connect() hands out stand-in clients.

function fakeClients(fail?: RegExp) {
  const clients: Array<{ texts: string[]; release: ReturnType<typeof vi.fn> }> = []
  const connect = vi.spyOn(pg.Pool.prototype, 'connect').mockImplementation((async () => {
    const texts: string[] = []
    const release = vi.fn()
    clients.push({ texts, release })
    return {
      release,
      query: vi.fn(async (q: string | { text: string }) => {
        const text = typeof q === 'string' ? q : q.text
        texts.push(text)
        if (fail?.test(text)) throw new Error('probe failed')
        return { rows: [{ '?column?': 1 }] }
      }),
    }
  }) as never)
  return { clients, connect }
}

// Taken when this file starts, so the restore undoes only its own changes.
let savedEnv: Record<string, string | undefined> = {}
beforeAll(() => {
  savedEnv = { ...process.env }
})
beforeEach(async () => {
  await closeDealflowRoPool()
  delete process.env.DEALFLOW_SYNC_STUB
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

describe('health: the DealFlow probe', () => {
  it('runs read-only and gives its client back to the pool', async () => {
    const { clients } = fakeClients()
    expect((await getHealth()).checks.dealflowRo).toBe('ok')
    expect(clients).toHaveLength(1)
    expect(clients[0].texts).toEqual(['BEGIN READ ONLY', 'SELECT 1', 'ROLLBACK'])
    expect(clients[0].release).toHaveBeenCalledTimes(1)
  })

  it('gives its client back when the probe fails too, and reports down', async () => {
    const { clients } = fakeClients(/SELECT 1/)
    expect((await getHealth()).checks.dealflowRo).toBe('down')
    expect(clients[0].texts).toEqual(['BEGIN READ ONLY', 'SELECT 1', 'ROLLBACK'])
    expect(clients[0].release).toHaveBeenCalledTimes(1)
  })

  it('reports down when DealFlow cannot be reached', async () => {
    vi.spyOn(pg.Pool.prototype, 'connect').mockRejectedValue(new Error('timeout exceeded when trying to connect') as never)
    expect((await getHealth()).checks.dealflowRo).toBe('down')
  })

  it('is skipped, without connecting, when the setting is unset or in stub mode', async () => {
    const { connect } = fakeClients()
    process.env.DEALFLOW_SYNC_STUB = '1'
    expect((await getHealth()).checks.dealflowRo).toBe('skipped')
    delete process.env.DEALFLOW_SYNC_STUB
    delete process.env.DATABASE_URL_DEALFLOW_RO
    expect((await getHealth()).checks.dealflowRo).toBe('skipped')
    expect(connect).not.toHaveBeenCalled()
  })
})
