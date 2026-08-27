import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import type { AddressInfo } from 'node:net'
import type { Server } from 'node:http'
import { createServer } from '../mocks/compliance/server'
import { checkCallable, type CallableEntry } from '../../src/lib/core-data/query-dsl/compliance-bridge'
import { REASON_CODES } from '../http/reason-codes'

// Gate 2 (A → mocks it CONSUMES): the mock compliance server is faithful to C's
// frozen contract — locked response shape, REASON_CODES-only reasons, and the
// 100-per-batch 413 cap — validated over real HTTP through A's bridge.

let server: Server
let baseUrl: string

beforeAll(async () => {
  server = createServer()
  await new Promise<void>((resolve) => server.listen(0, resolve))
  const port = (server.address() as AddressInfo).port
  baseUrl = `http://127.0.0.1:${port}`
})

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()))
})

describe('mock compliance — response fidelity via the bridge', () => {
  it('returns locked shape with reasons only from REASON_CODES', async () => {
    const entries: CallableEntry[] = [
      { contactPhoneId: '1', phone: '+12125550001', timezone: 'America/New_York' }, // clean
      { contactPhoneId: '2', phone: '+1212555DNC0', timezone: 'America/New_York' }, // internal_dnc
      { contactPhoneId: '3', phone: '+12125550003' }, // no tz → timezone_unresolved
    ]
    const outcome = await checkCallable(entries, { baseUrl })
    expect(outcome.connectivityFailure).toBe(false)
    expect(outcome.byPhoneId.get('1')?.callable).toBe(true)
    expect(outcome.byPhoneId.get('2')?.callable).toBe(false)
    expect(outcome.byPhoneId.get('2')?.reasons).toContain('internal_dnc')
    expect(outcome.byPhoneId.get('3')?.callable).toBe(false)
    expect(outcome.byPhoneId.get('3')?.reasons).toContain('timezone_unresolved')

    // Every returned reason is a member of the frozen enum.
    for (const v of outcome.byPhoneId.values()) {
      for (const r of v.reasons) expect(REASON_CODES).toContain(r)
    }
  })

  it('rejects an oversized batch with HTTP 413', async () => {
    const ids = Array.from({ length: 101 }, (_, i) => String(i))
    const res = await fetch(`${baseUrl}/api/compliance/callable-now`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ contactPhoneIds: ids }),
    })
    expect(res.status).toBe(413)
  })

  it('the bridge batches at 100 so it never trips the mock cap', async () => {
    // 150 entries → 2 batches (100 + 50), all resolved, no connectivity failure.
    const entries: CallableEntry[] = Array.from({ length: 150 }, (_, i) => ({
      contactPhoneId: `p${i}`,
      phone: `+1212555${(1000 + i).toString().slice(-4)}`,
      timezone: 'America/New_York',
    }))
    const outcome = await checkCallable(entries, { baseUrl, batchSize: 100 })
    expect(outcome.connectivityFailure).toBe(false)
    expect(outcome.byPhoneId.size).toBe(150)
  })
})
