import { EventEmitter } from 'node:events'
import { describe, it, expect, vi } from 'vitest'
import { createCallListener, type CallSubscriber, type ListenClient } from '@/lib/telephony/stream/listener'

// Brief 50 PR 1 (open item 6.1), engineering precautions: the one LISTEN
// connection per server instance behind the live call-status stream. A
// stand-in client here; tests/unit/call-stream-route.test.ts drives it through
// the route and tests/integration-local/call-stream.test.ts on a real Postgres.

class FakeClient extends EventEmitter implements ListenClient {
  sent: string[] = []
  ended = 0
  constructor(private readonly connectImpl: () => Promise<void> = async () => {}) {
    super()
  }
  connect = vi.fn(() => this.connectImpl())
  query = vi.fn(async (text: string) => {
    this.sent.push(text)
  })
  end = vi.fn(async () => {
    this.ended += 1
    setImmediate(() => this.emit('end'))
  })
  notify(payload: string | undefined, channel = 'crm_call'): void {
    this.emit('notification', { channel, payload, processId: 1 })
  }
}

function harness(connectImpl?: () => Promise<void>) {
  const clients: FakeClient[] = []
  const listener = createCallListener(() => {
    const c = new FakeClient(connectImpl)
    clients.push(c)
    return c
  })
  return { listener, clients }
}

function subscriber(): CallSubscriber & { events: string[]; drops: number } {
  const s = {
    events: [] as string[],
    drops: 0,
    onEvent: (p: string) => void s.events.push(p),
    onDrop: () => void (s.drops += 1),
  }
  return s
}

const settle = () => new Promise<void>((r) => setImmediate(r))

describe('createCallListener', () => {
  it('subscribers arriving together share one connection and one LISTEN', async () => {
    const { listener, clients } = harness()
    const [a, b, c] = [subscriber(), subscriber(), subscriber()]
    await Promise.all([listener.subscribe(a), listener.subscribe(b), listener.subscribe(c)])
    expect(clients).toHaveLength(1)
    expect(clients[0].connect).toHaveBeenCalledTimes(1)
    expect(clients[0].sent).toEqual(['LISTEN crm_call'])
    expect(listener.stats()).toEqual({ subscribers: 3, open: true })
  })

  it('fans each crm_call event out to every subscriber and ignores other channels and empty payloads', async () => {
    const { listener, clients } = harness()
    const [a, b] = [subscriber(), subscriber()]
    await listener.subscribe(a)
    await listener.subscribe(b)
    clients[0].notify('{"type":"call.connected","callId":"call_test_1"}')
    clients[0].notify('{"type":"message.received"}', 'crm_message')
    clients[0].notify(undefined)
    expect(a.events).toEqual(['{"type":"call.connected","callId":"call_test_1"}'])
    expect(b.events).toEqual(a.events)
  })

  it('a subscriber that throws is dropped from the list without stopping the others', async () => {
    const { listener, clients } = harness()
    const broken: CallSubscriber = { onEvent: () => { throw new TypeError('Invalid state: Controller is already closed') }, onDrop: () => {} }
    const ok = subscriber()
    await listener.subscribe(broken)
    await listener.subscribe(ok)
    expect(() => clients[0].notify('{"n":1}')).not.toThrow()
    clients[0].notify('{"n":2}')
    expect(ok.events).toEqual(['{"n":1}', '{"n":2}'])
    expect(listener.stats().subscribers).toBe(1)
  })

  it('if the subscriber that throws was the last one, the connection is let go', async () => {
    const { listener, clients } = harness()
    await listener.subscribe({ onEvent: () => { throw new TypeError('closed') }, onDrop: () => {} })
    clients[0].notify('{"n":1}')
    expect(clients[0].end).toHaveBeenCalledTimes(1)
    expect(listener.stats()).toEqual({ subscribers: 0, open: false })
  })

  it('leaving twice is harmless; the connection closes when the last subscriber leaves', async () => {
    const { listener, clients } = harness()
    const leaveA = await listener.subscribe(subscriber())
    const leaveB = await listener.subscribe(subscriber())
    leaveA()
    leaveA()
    expect(clients[0].end).not.toHaveBeenCalled()
    leaveB()
    expect(clients[0].end).toHaveBeenCalledTimes(1)
    expect(listener.stats()).toEqual({ subscribers: 0, open: false })

    // The released client's own 'end' (and anything late from it) is ignored.
    await settle()
    const c = subscriber()
    await listener.subscribe(c)
    expect(clients).toHaveLength(2)
    clients[0].notify('{"stale":true}')
    clients[0].emit('error', new Error('late'))
    expect(c.events).toEqual([])
    expect(c.drops).toBe(0)
    expect(listener.stats()).toEqual({ subscribers: 1, open: true })
  })

  it('a subscriber joining just as the last one leaves keeps the connection instead of losing it', async () => {
    const { listener, clients } = harness()
    const leaveA = await listener.subscribe(subscriber())
    const joining = listener.subscribe(subscriber()) // waiting on the open connection
    leaveA()
    await joining
    expect(clients).toHaveLength(1)
    expect(clients[0].end).not.toHaveBeenCalled()
    expect(listener.stats()).toEqual({ subscribers: 1, open: true })
  })

  it("an 'error' tells every subscriber once, closes the client, and the next subscriber opens a fresh one", async () => {
    const { listener, clients } = harness()
    const [a, b] = [subscriber(), subscriber()]
    await listener.subscribe(a)
    await listener.subscribe(b)
    expect(() => clients[0].emit('error', new Error('Connection terminated unexpectedly'))).not.toThrow()
    clients[0].emit('end')
    expect([a.drops, b.drops]).toEqual([1, 1])
    expect(clients[0].end).toHaveBeenCalledTimes(1)
    expect(listener.stats()).toEqual({ subscribers: 0, open: false })

    await listener.subscribe(subscriber())
    expect(clients).toHaveLength(2)
  })

  it('a failed connect rejects every waiting subscriber (no onDrop) and the next one tries again', async () => {
    let fail = true
    const { listener, clients } = harness(async () => {
      if (fail) throw new Error('connect ECONNREFUSED')
    })
    const [a, b] = [subscriber(), subscriber()]
    const results = await Promise.allSettled([listener.subscribe(a), listener.subscribe(b)])
    expect(results.map((r) => r.status)).toEqual(['rejected', 'rejected'])
    expect([a.drops, b.drops]).toEqual([0, 0])
    expect(clients).toHaveLength(1)
    expect(listener.stats()).toEqual({ subscribers: 0, open: false })

    fail = false
    await listener.subscribe(subscriber())
    expect(clients).toHaveLength(2)
    expect(clients[1].sent).toEqual(['LISTEN crm_call'])
  })

  it('a connection that drops while opening rejects the waiting subscribers', async () => {
    let finish!: () => void
    const { listener, clients } = harness(() => new Promise<void>((r) => (finish = r)))
    const pending = listener.subscribe(subscriber())
    await settle()
    clients[0].emit('error', new Error('Connection terminated unexpectedly'))
    finish()
    await expect(pending).rejects.toThrow()
    expect(listener.stats()).toEqual({ subscribers: 0, open: false })
  })

  it('close() lets everything go: subscribers are told, the client is ended', async () => {
    const { listener, clients } = harness()
    const a = subscriber()
    await listener.subscribe(a)
    await listener.close()
    expect(a.drops).toBe(1)
    expect(clients[0].end).toHaveBeenCalledTimes(1)
    expect(listener.stats()).toEqual({ subscribers: 0, open: false })
  })
})
