import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { PersistableMessage } from './gmail-sync'
import type { ThreadAggregate } from './thread-reconstruct'

const db = vi.hoisted(() => ({
  contactEmail: { findMany: vi.fn() },
  message: { findMany: vi.fn(), createMany: vi.fn(), findUnique: vi.fn() },
  emailThread: { upsert: vi.fn() },
  oAuthCredential: { update: vi.fn() },
}))
const events = vi.hoisted(() => ({ notifyMessageReceived: vi.fn() }))
vi.mock('../../prisma', () => ({ prisma: db }))
vi.mock('../events', () => events)

import {
  resolveContact,
  saveMessages,
  upsertThread,
  emitMessageReceived,
  createGmailSyncPorts,
} from './gmail-adapter'

beforeEach(() => vi.clearAllMocks())

function row(providerMessageId: string): PersistableMessage {
  return {
    providerMessageId,
    providerThreadId: 'gmail:T',
    threadDbId: 'db-T',
    channel: 'email',
    direction: 'incoming',
    status: 'inbox',
    fromAddress: 'a@b.com',
    toAddresses: ['ryan@elliman.com'],
    ccAddresses: [],
    bccAddresses: [],
    activityAt: new Date('2026-08-08T10:00:00Z'),
    contactId: null,
    leadId: null,
  }
}

function agg(over: Partial<ThreadAggregate>): ThreadAggregate {
  return {
    providerThreadId: 'gmail:T',
    subject: 'Hi',
    participants: ['a@b.com', 'ryan@elliman.com'],
    firstMessageAt: new Date('2026-08-08T10:00:00Z'),
    lastMessageAt: new Date('2026-08-08T11:00:00Z'),
    messageCount: 2,
    contactId: null,
    leadId: null,
    ...over,
  }
}

describe('resolveContact', () => {
  it('returns the earliest-appearing exact match', async () => {
    db.contactEmail.findMany.mockResolvedValue([
      { email: 'bob@example.com', contact: { id: 'cB', leadId: 'lB' } },
      { email: 'alice@example.com', contact: { id: 'cA', leadId: 'lA' } },
    ])
    const m = await resolveContact('org', [
      'ryan@elliman.com',
      'alice@example.com',
      'bob@example.com',
    ])
    expect(m).toEqual({ contactId: 'cA', leadId: 'lA' })
  })

  it('returns null when nothing matches', async () => {
    db.contactEmail.findMany.mockResolvedValue([])
    expect(await resolveContact('org', ['x@y.com'])).toBeNull()
  })

  it('short-circuits on empty input (no query)', async () => {
    expect(await resolveContact('org', [])).toBeNull()
    expect(db.contactEmail.findMany).not.toHaveBeenCalled()
  })
})

describe('saveMessages', () => {
  it('inserts only new messages and returns their ids (dedup on providerMessageId)', async () => {
    db.message.findMany.mockResolvedValue([{ providerMessageId: 'gmail:existing' }])
    db.message.createMany.mockResolvedValue({ count: 1 })

    const { insertedIds } = await saveMessages('org', [
      row('gmail:existing'),
      row('gmail:new'),
    ])
    expect(insertedIds).toEqual(['gmail:new'])

    const arg = db.message.createMany.mock.calls[0][0] as any
    expect(arg.skipDuplicates).toBe(true)
    expect(arg.data).toHaveLength(1)
    expect(arg.data[0].providerMessageId).toBe('gmail:new')
    expect(arg.data[0].organizationId).toBe('org')
    expect(arg.data[0].threadId).toBe('db-T')
  })

  it('does nothing when the batch is empty', async () => {
    const r = await saveMessages('org', [])
    expect(r.insertedIds).toEqual([])
    expect(db.message.findMany).not.toHaveBeenCalled()
  })

  it('skips createMany when every message already exists', async () => {
    db.message.findMany.mockResolvedValue([{ providerMessageId: 'gmail:a' }])
    const { insertedIds } = await saveMessages('org', [row('gmail:a')])
    expect(insertedIds).toEqual([])
    expect(db.message.createMany).not.toHaveBeenCalled()
  })
})

describe('upsertThread', () => {
  it('does not clobber contactId with null on update (reconcile-safe)', async () => {
    db.emailThread.upsert.mockResolvedValue({ id: 'tid' })
    await upsertThread('org', agg({ contactId: null, leadId: null }))
    const arg = db.emailThread.upsert.mock.calls[0][0] as any
    expect(arg.update).not.toHaveProperty('contactId')
    expect(arg.create.contactId).toBeNull()
  })

  it('writes contactId/leadId on update when resolved', async () => {
    db.emailThread.upsert.mockResolvedValue({ id: 'tid' })
    await upsertThread('org', agg({ contactId: 'cA', leadId: 'lA' }))
    const arg = db.emailThread.upsert.mock.calls[0][0] as any
    expect(arg.update.contactId).toBe('cA')
    expect(arg.update.leadId).toBe('lA')
    expect(arg.where).toEqual({ providerThreadId: 'gmail:T' })
  })
})

describe('emitMessageReceived', () => {
  it('looks up the row id and NOTIFYs the message.received shape', async () => {
    db.message.findUnique.mockResolvedValue({ id: 'db1' })
    await emitMessageReceived({ ...row('gmail:<x>'), contactId: 'c1', leadId: 'l1' })
    expect(events.notifyMessageReceived).toHaveBeenCalledWith(
      expect.objectContaining({ messageId: 'db1', channel: 'email', contactId: 'c1', leadId: 'l1' }),
    )
  })

  it('skips the NOTIFY when the row is missing', async () => {
    db.message.findUnique.mockResolvedValue(null)
    await emitMessageReceived(row('gmail:<y>'))
    expect(events.notifyMessageReceived).not.toHaveBeenCalled()
  })
})

describe('createGmailSyncPorts', () => {
  it('wires a SyncPorts object', () => {
    const ports = createGmailSyncPorts({
      orgId: 'o',
      credentialId: 'cred',
      connectedEmail: 'ryan@elliman.com',
      accessToken: 'AT',
    })
    expect(ports.connectedEmail).toBe('ryan@elliman.com')
    expect(typeof ports.listThreadIds).toBe('function')
    expect(typeof ports.resolveContact).toBe('function')
    expect(typeof ports.upsertThread).toBe('function')
    expect(typeof ports.setHistoryId).toBe('function')
  })

  it('the DB-backed ports delegate to the module functions', async () => {
    db.contactEmail.findMany.mockResolvedValue([])
    db.emailThread.upsert.mockResolvedValue({ id: 'tid' })
    db.message.findMany.mockResolvedValue([])
    db.message.findUnique.mockResolvedValue({ id: 'db1' })
    db.oAuthCredential.update.mockResolvedValue({})

    const ports = createGmailSyncPorts({
      orgId: 'o',
      credentialId: 'cred',
      connectedEmail: 'r@e.com',
      accessToken: 'AT',
    })
    expect(await ports.resolveContact(['x@y.com'])).toBeNull()
    expect(await ports.upsertThread(agg({}))).toEqual({ id: 'tid' })
    expect(await ports.saveMessages([])).toEqual({ insertedIds: [] })
    await ports.emitMessageReceived(row('gmail:<z>'))
    await ports.setHistoryId('999')
    expect(db.oAuthCredential.update).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 'cred' }, data: { gmailHistoryId: '999' } }),
    )
  })
})
