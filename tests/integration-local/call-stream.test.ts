import 'dotenv/config'
import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest'
import pg from 'pg'
import { GET } from '@/app/api/telephony/stream/route'
import { sharedCallListener } from '@/lib/telephony/stream/listener'
import { mainIsTestDb } from '../setup/live-guard'

// Brief 50 PR 1 (open item 6.1; finding M1 of the 2026-10-05 audit),
// engineering precautions. The live call-status stream on a real Postgres:
// the route handler, its real SSE body, and real LISTEN/NOTIFY. Two tabs share
// one listening connection; a connection Postgres drops is handled without a
// crash; while calling is off nothing connects at all.
const enabled = mainIsTestDb() // Brief 41: refuses a live DATABASE_URL_MAIN

const settle = () => new Promise<void>((r) => setTimeout(r, 20))

class Tab {
  text = ''
  done = false
  private reader: ReadableStreamDefaultReader<Uint8Array>

  constructor(readonly res: Response) {
    this.reader = res.body!.getReader()
    void this.pump()
  }

  private async pump(): Promise<void> {
    const decoder = new TextDecoder()
    try {
      for (;;) {
        const { value, done } = await this.reader.read()
        if (done) break
        this.text += decoder.decode(value)
      }
    } catch {
      /* an errored stream ends the tab's read, as a network error would */
    }
    this.done = true
  }

  async waitFor(check: () => boolean, label: string, ms = 10_000): Promise<void> {
    const deadline = Date.now() + ms
    while (!check()) {
      if (Date.now() > deadline) throw new Error(`timed out waiting for: ${label}\nreceived: ${JSON.stringify(this.text)}`)
      await settle()
    }
  }

  ready(): Promise<void> {
    return this.waitFor(() => this.text.includes('event: ready'), 'event: ready')
  }

  async close(): Promise<void> {
    if (!this.done) await this.reader.cancel().catch(() => {})
  }
}

describe.runIf(enabled)('the call-status stream on a real Postgres', () => {
  let admin: pg.Client
  const tabs: Tab[] = []
  const savedDialing = process.env.DIALING_ENABLED

  async function openTab(): Promise<Tab> {
    const tab = new Tab(await GET(new Request('http://localhost/api/telephony/stream')))
    tabs.push(tab)
    return tab
  }

  /** Backends on this database whose last statement was the stream's LISTEN. */
  async function listeners(): Promise<number[]> {
    const { rows } = await admin.query<{ pid: number }>(
      `SELECT pid FROM pg_stat_activity
        WHERE datname = current_database() AND pid <> pg_backend_pid() AND query = 'LISTEN crm_call'`,
    )
    return rows.map((r) => r.pid)
  }

  async function waitForListeners(n: number): Promise<number[]> {
    const deadline = Date.now() + 10_000
    for (;;) {
      const pids = await listeners()
      if (pids.length === n) return pids
      if (Date.now() > deadline) throw new Error(`expected ${n} listening connection(s), found ${pids.length}`)
      await settle()
    }
  }

  beforeAll(async () => {
    admin = new pg.Client({ connectionString: process.env.DATABASE_URL_MAIN })
    await admin.connect()
  })

  afterEach(async () => {
    await Promise.all(tabs.splice(0).map((t) => t.close()))
    if (savedDialing === undefined) delete process.env.DIALING_ENABLED
    else process.env.DIALING_ENABLED = savedDialing
    await waitForListeners(0)
  })

  afterAll(async () => {
    await sharedCallListener().close()
    await admin?.end()
  })

  it('while calling is off: 204 and no database connection', async () => {
    delete process.env.DIALING_ENABLED
    const res = await GET(new Request('http://localhost/api/telephony/stream'))
    expect(res.status).toBe(204)
    await settle()
    expect(await listeners()).toHaveLength(0)
  })

  it('two tabs share one listening connection, and a NOTIFY reaches both', async () => {
    process.env.DIALING_ENABLED = 'true'
    const a = await openTab()
    const b = await openTab()
    await a.ready()
    await b.ready()
    expect(await waitForListeners(1)).toHaveLength(1)

    const evt = { type: 'call.connected', callId: 'call_test_b50_1', connectedAt: '2026-10-19T12:00:00.000Z' }
    await admin.query(`SELECT pg_notify('crm_call', $1)`, [JSON.stringify(evt)])
    const frame = `data: ${JSON.stringify(evt)}\n\n`
    await a.waitFor(() => a.text.includes(frame), 'the event in tab a')
    await b.waitFor(() => b.text.includes(frame), 'the event in tab b')

    // The connection stays while one tab is open and goes with the last one.
    await a.close()
    await settle()
    expect(await listeners()).toHaveLength(1)
    await b.close()
    await waitForListeners(0)
  })

  it('Postgres dropping the connection does not crash anything: both tabs close with a retry hint, the next tab reconnects', async () => {
    process.env.DIALING_ENABLED = 'true'
    const a = await openTab()
    const b = await openTab()
    await a.ready()
    await b.ready()
    const [pid] = await waitForListeners(1)

    // What a Railway restart looks like to the listener: the server ends it.
    await admin.query('SELECT pg_terminate_backend($1)', [pid])
    await a.waitFor(() => a.done, 'tab a closed')
    await b.waitFor(() => b.done, 'tab b closed')
    expect(a.text).toMatch(/retry: \d+\n\n$/)
    expect(b.text).toMatch(/retry: \d+\n\n$/)
    await waitForListeners(0)

    const c = await openTab()
    await c.ready()
    const [fresh] = await waitForListeners(1)
    expect(fresh).not.toBe(pid)
    await admin.query(`SELECT pg_notify('crm_call', $1)`, [JSON.stringify({ type: 'call.completed', callId: 'call_test_b50_2' })])
    await c.waitFor(() => c.text.includes('call_test_b50_2'), 'the event after reconnecting')
  })
})
