import { describe, it, expect } from 'vitest'
import { fullBackfill, deltaSync, type SyncPorts, type PersistableMessage } from './gmail-sync'
import type { ParsedEmail } from './parse'

const RYAN = 'ryan@elliman.com'

function mk(p: {
  id: string
  threadId: string
  from: string
  to?: string[]
  subject?: string
  date: string
}): ParsedEmail {
  return {
    providerMessageId: `gmail:${p.id}`,
    providerThreadId: `gmail:${p.threadId}`,
    references: [],
    fromAddress: p.from,
    toAddresses: p.to ?? [],
    ccAddresses: [],
    bccAddresses: [],
    subject: p.subject,
    date: new Date(p.date),
  }
}

// Two threads: A = [incoming alice, outgoing ryan], B = [incoming bob].
const THREADS: Record<string, ParsedEmail[]> = {
  A: [
    mk({ id: 'a1', threadId: 'A', from: 'alice@example.com', to: [RYAN], subject: 'Interested', date: '2026-08-08T10:00:00Z' }),
    mk({ id: 'a2', threadId: 'A', from: RYAN, to: ['alice@example.com'], subject: 'Re: Interested', date: '2026-08-08T11:00:00Z' }),
  ],
  B: [mk({ id: 'b1', threadId: 'B', from: 'bob@example.com', to: [RYAN], subject: 'Question', date: '2026-08-08T12:00:00Z' })],
}

function makeFakePorts() {
  const saved = new Set<string>() // simulates the unique providerMessageId index
  const emitted: PersistableMessage[] = []
  const savedRows: PersistableMessage[] = []
  const historyIds: string[] = []

  const ports: SyncPorts = {
    connectedEmail: RYAN,
    listThreadIds: async () => ['A', 'B'],
    getThreadMessages: async (threadId) => THREADS[threadId] ?? [],
    listChangedThreadIds: async () => ({ threadIds: ['B'], latestHistoryId: '999' }),
    resolveContact: async (emails) =>
      emails.includes('alice@example.com')
        ? { contactId: 'cA', leadId: 'lA' }
        : emails.includes('bob@example.com')
          ? { contactId: 'cB', leadId: 'lB' }
          : null,
    upsertThread: async (agg) => ({ id: `db-${agg.providerThreadId}` }),
    saveMessages: async (rows) => {
      const insertedIds: string[] = []
      for (const r of rows) {
        if (!saved.has(r.providerMessageId)) {
          saved.add(r.providerMessageId)
          savedRows.push(r)
          insertedIds.push(r.providerMessageId)
        }
      }
      return { insertedIds }
    },
    emitMessageReceived: async (msg) => {
      emitted.push(msg)
    },
    setHistoryId: async (h) => {
      historyIds.push(h)
    },
  }
  return { ports, emitted, savedRows, historyIds }
}

describe('fullBackfill', () => {
  it('persists all messages, emits message.received for inbound only', async () => {
    const { ports, emitted, savedRows } = makeFakePorts()
    const res = await fullBackfill(ports, '2026/08/01')

    expect(res.threads).toBe(2)
    expect(res.messagesInserted).toBe(3) // a1, a2, b1
    expect(res.emitted).toBe(2) // alice + bob incoming; ryan's outgoing copy excluded

    const emittedIds = emitted.map((m) => m.providerMessageId).sort()
    expect(emittedIds).toEqual(['gmail:a1', 'gmail:b1'])

    // direction + status mapping
    const a2 = savedRows.find((r) => r.providerMessageId === 'gmail:a2')!
    expect(a2.direction).toBe('outgoing')
    expect(a2.status).toBe('sent')
    const a1 = savedRows.find((r) => r.providerMessageId === 'gmail:a1')!
    expect(a1.direction).toBe('incoming')
    expect(a1.status).toBe('inbox')
    expect(a1.contactId).toBe('cA') // thread linked via alice
  })

  it('is idempotent: a second backfill inserts nothing and re-emits nothing', async () => {
    const { ports, emitted } = makeFakePorts()
    await fullBackfill(ports, '2026/08/01')
    const second = await fullBackfill(ports, '2026/08/01')

    expect(second.messagesInserted).toBe(0)
    expect(second.emitted).toBe(0)
    expect(emitted).toHaveLength(2) // unchanged from the first run
  })
})

describe('deltaSync', () => {
  it('syncs changed threads and advances the historyId cursor after success', async () => {
    const { ports, emitted, historyIds } = makeFakePorts()
    const res = await deltaSync(ports, '100')

    expect(res.messagesInserted).toBe(1) // bob
    expect(res.emitted).toBe(1)
    expect(emitted[0].providerMessageId).toBe('gmail:b1')
    expect(historyIds).toEqual(['999']) // cursor advanced exactly once, after the batch
  })

  it('does not advance the cursor when no latestHistoryId is returned', async () => {
    const { ports, historyIds } = makeFakePorts()
    ports.listChangedThreadIds = async () => ({ threadIds: [], latestHistoryId: undefined })
    await deltaSync(ports, '100')
    expect(historyIds).toEqual([])
  })

  it('leaves the cursor unadvanced if a thread sync throws (never lose a message)', async () => {
    const { ports, historyIds } = makeFakePorts()
    ports.getThreadMessages = async () => {
      throw new Error('gmail 503')
    }
    await expect(deltaSync(ports, '100')).rejects.toThrow('gmail 503')
    expect(historyIds).toEqual([]) // setHistoryId never reached
  })
})
