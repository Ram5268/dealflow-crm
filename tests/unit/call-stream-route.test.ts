import { describe, it, expect, vi, beforeAll, beforeEach, afterEach, afterAll } from 'vitest'
import pg from 'pg'
import * as route from '@/app/api/telephony/stream/route'
import { sharedCallListener } from '@/lib/telephony/stream/listener'

// Brief 50 PR 1 (open item 6.1; finding M1 of the 2026-10-05 audit),
// engineering precautions. The live call-status stream (`GET
// /api/telephony/stream`, the SSE bridge over Postgres `LISTEN crm_call`) used
// to open its own database connection for every open page in every tab, even
// while calling is off, with no 'error' handler: a dropped connection crashed
// the function and many tabs could use up the database's connections.
//
// No database here: pg.Client's connect/query/end are replaced, so no socket
// is ever opened. tests/integration-local/call-stream.test.ts runs the same
// story on a real Postgres.

type PgClient = InstanceType<typeof pg.Client>

let clients: PgClient[] = []
let sent: Array<{ client: PgClient; text: string }> = []
let ended: PgClient[] = []
let connectImpl: () => Promise<void> = async () => {}
const tabs: Tab[] = []

let savedEnv: Record<string, string | undefined> = {}
beforeAll(() => {
  savedEnv = { DIALING_ENABLED: process.env.DIALING_ENABLED, DATABASE_URL_MAIN: process.env.DATABASE_URL_MAIN }
})
afterAll(() => {
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
})

beforeEach(() => {
  clients = []
  sent = []
  ended = []
  connectImpl = async () => {}
  // An address nothing listens on: connect() is replaced, no socket is opened.
  process.env.DATABASE_URL_MAIN = 'postgresql://u:p@127.0.0.1:9/crm_call_stream_unit_test'
  vi.spyOn(pg.Client.prototype, 'connect').mockImplementation(async function (this: PgClient) {
    clients.push(this)
    await connectImpl()
  } as never)
  vi.spyOn(pg.Client.prototype, 'query').mockImplementation(async function (this: PgClient, text: unknown) {
    sent.push({ client: this, text: String(text) })
    return { rows: [] }
  } as never)
  vi.spyOn(pg.Client.prototype, 'end').mockImplementation(async function (this: PgClient) {
    ended.push(this)
    // Like a real client: 'end' follows once the socket has closed.
    setImmediate(() => this.emit('end'))
  } as never)
})

afterEach(async () => {
  await Promise.all(tabs.splice(0).map((t) => t.close()))
  await settle()
  // Suite 1 runs every file in one process: never hand a stand-in connection
  // on to the next file, even after a failed test.
  await sharedCallListener().close()
  vi.useRealTimers()
  vi.restoreAllMocks()
})

const settle = () => new Promise<void>((r) => setImmediate(r))
const LISTEN = 'LISTEN crm_call'
const listens = () => sent.filter((s) => s.text === LISTEN)

/** One browser tab's EventSource, reduced to the raw text it has received. */
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

  /** Polls on setImmediate, which the fake timers below leave real. */
  async waitFor(check: () => boolean, label: string): Promise<void> {
    for (let i = 0; i < 2000; i++) {
      if (check()) return
      await settle()
    }
    throw new Error(`timed out waiting for: ${label}\nreceived so far: ${JSON.stringify(this.text)}`)
  }

  ready(): Promise<void> {
    return this.waitFor(() => this.text.includes('event: ready'), 'event: ready')
  }

  async close(): Promise<void> {
    if (!this.done) await this.reader.cancel().catch(() => {})
  }
}

async function openTab(signal?: AbortSignal): Promise<Tab> {
  const req = new Request('http://localhost/api/telephony/stream', { signal })
  const tab = new Tab(await route.GET(req))
  tabs.push(tab)
  return tab
}

function notify(client: PgClient, payload: unknown, channel = 'crm_call'): void {
  client.emit('notification', { channel, payload: JSON.stringify(payload), processId: 1 })
}

describe('while calling is off (DIALING_ENABLED is not "true")', () => {
  it('answers 204 No Content (which tells a browser not to reconnect) and opens no database connection', async () => {
    for (const value of [undefined, 'false', '1']) {
      if (value === undefined) delete process.env.DIALING_ENABLED
      else process.env.DIALING_ENABLED = value
      const res = await route.GET(new Request('http://localhost/api/telephony/stream'))
      await settle()
      expect(res.status).toBe(204)
      expect(res.body).toBeNull()
    }
    expect(pg.Client.prototype.connect).not.toHaveBeenCalled()
    expect(sent).toHaveLength(0)
  })
})

describe('while calling is on', () => {
  beforeEach(() => {
    process.env.DIALING_ENABLED = 'true'
  })

  it('two tabs share one connection and one LISTEN, and an event reaches both', async () => {
    const a = await openTab()
    const b = await openTab()
    await a.ready()
    await b.ready()

    expect(clients).toHaveLength(1)
    expect(listens()).toHaveLength(1)
    expect(a.res.headers.get('content-type')).toBe('text/event-stream')

    const evt = { type: 'call.connected', callId: 'call_test_1', connectedAt: '2026-10-19T12:00:00.000Z' }
    notify(clients[0], evt)
    const frame = `data: ${JSON.stringify(evt)}\n\n`
    await a.waitFor(() => a.text.includes(frame), 'the event in tab a')
    await b.waitFor(() => b.text.includes(frame), 'the event in tab b')
  })

  it('lets the connection go when the last tab closes, not before', async () => {
    const a = await openTab()
    const b = await openTab()
    await a.ready()
    await b.ready()

    await a.close()
    await settle()
    expect(ended).toHaveLength(0)

    await b.close()
    await settle()
    expect(clients).toHaveLength(1)
    expect(ended).toEqual([clients[0]])
  })

  it('a dropped connection does not crash: open tabs are closed with a retry hint, and the next tab gets a fresh connection', async () => {
    const a = await openTab()
    const b = await openTab()
    await a.ready()
    await b.ready()
    const first = clients[0]

    // Railway drops the connection. With no 'error' handler this event throws.
    expect(() => first.emit('error', new Error('Connection terminated unexpectedly'))).not.toThrow()
    await a.waitFor(() => a.done, 'tab a closed')
    await b.waitFor(() => b.done, 'tab b closed')
    expect(a.text).toMatch(/retry: \d+\n\n$/)
    expect(b.text).toMatch(/retry: \d+\n\n$/)
    expect(ended).toContain(first)

    // A late 'end' (or another 'error') from the dropped client changes nothing.
    expect(() => first.emit('end')).not.toThrow()
    expect(() => first.emit('error', new Error('again'))).not.toThrow()

    const c = await openTab()
    await c.ready()
    expect(clients).toHaveLength(2)
    expect(clients[1]).not.toBe(first)
    notify(clients[1], { type: 'call.completed', callId: 'call_test_2', disposition: 'answered' })
    await c.waitFor(() => c.text.includes('call_test_2'), 'the event on the fresh connection')
  })

  it('a connection that ends without an error is handled the same way', async () => {
    const a = await openTab()
    await a.ready()
    expect(() => clients[0].emit('end')).not.toThrow()
    await a.waitFor(() => a.done, 'tab a closed')
    expect(a.text).toMatch(/retry: \d+\n\n$/)
  })

  it('a failed connect closes the stream with a retry hint, and the next tab tries again', async () => {
    connectImpl = async () => {
      throw new Error('connect ECONNREFUSED')
    }
    const a = await openTab()
    await a.waitFor(() => a.done, 'tab a closed')
    expect(a.text).toMatch(/retry: \d+\n\n$/)
    expect(a.text).not.toContain('event: ready')

    connectImpl = async () => {}
    const b = await openTab()
    await b.ready()
    expect(clients).toHaveLength(2)
  })

  it('a tab that leaves while the connection is still opening does not leave it open', async () => {
    let finishConnect!: () => void
    connectImpl = () => new Promise<void>((r) => (finishConnect = r))
    const a = await openTab()
    await a.waitFor(() => clients.length === 1, 'connect started')
    await a.close()
    finishConnect()
    await a.waitFor(() => ended.length === 1, 'the connection let go')
    expect(ended).toEqual([clients[0]])
  })

  it('a connect that hangs still ends the stream before the time limit, and the late connection is let go', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] })
    let finishConnect!: () => void
    connectImpl = () => new Promise<void>((r) => (finishConnect = r))
    const a = await openTab()
    await a.waitFor(() => clients.length === 1, 'connect started')
    await vi.advanceTimersByTimeAsync(299_000)
    await a.waitFor(() => a.done, 'the stream ended')
    finishConnect()
    await a.waitFor(() => ended.length === 1, 'the late connection let go')
  })

  it('a browser that disconnects (request aborted) releases its share', async () => {
    const ctl = new AbortController()
    const a = await openTab(ctl.signal)
    await a.ready()
    ctl.abort()
    await a.waitFor(() => ended.length === 1, 'the connection let go')
    expect(a.done).toBe(true)
  })

  it('sends a keepalive comment and ends the stream itself before Vercel stops the function', async () => {
    expect(route.maxDuration).toBe(300)
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] })
    const a = await openTab()
    await a.ready()

    await vi.advanceTimersByTimeAsync(30_000)
    expect(a.text).toContain(': keepalive\n\n')
    expect(a.done).toBe(false)

    await vi.advanceTimersByTimeAsync(300_000 - 30_000 - 1)
    await a.waitFor(() => a.done, 'the stream ended before maxDuration')
    await settle()
    expect(ended).toEqual([clients[0]])
  })
})
