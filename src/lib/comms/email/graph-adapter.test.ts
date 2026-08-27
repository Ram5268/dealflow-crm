import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

const db = vi.hoisted(() => ({
  contactEmail: { findMany: vi.fn() },
  message: { findMany: vi.fn(), createMany: vi.fn(), findUnique: vi.fn() },
  emailThread: { upsert: vi.fn() },
}))
const store = vi.hoisted(() => ({ updateGraphDeltaLink: vi.fn(), updateGmailHistoryId: vi.fn() }))
const events = vi.hoisted(() => ({ notifyMessageReceived: vi.fn() }))
vi.mock('../../prisma', () => ({ prisma: db }))
vi.mock('../oauth/store', () => store)
vi.mock('../events', () => events)

import { createGraphSyncPorts } from './graph-adapter'

const fetchMock = vi.fn()
beforeEach(() => {
  vi.clearAllMocks()
  vi.stubGlobal('fetch', fetchMock)
  process.env.GRAPH_API_BASE = 'https://graph.test/v1.0'
  delete process.env.GRAPH_MOCK_URL
})
afterEach(() => vi.unstubAllGlobals())

const okJson = (b: unknown) => ({ ok: true, status: 200, json: async () => b, text: async () => JSON.stringify(b) })

const ports = () =>
  createGraphSyncPorts({ orgId: 'o', credentialId: 'cred', connectedEmail: 'ryan@elliman.com', accessToken: 'AT' })

describe('createGraphSyncPorts', () => {
  it('maps Graph delta into listChangedThreadIds (conversationIds + deltaLink)', async () => {
    fetchMock.mockResolvedValueOnce(okJson({ value: [{ conversationId: 'c1' }], '@odata.deltaLink': 'DL' }))
    expect(await ports().listChangedThreadIds('')).toEqual({ threadIds: ['c1'], latestHistoryId: 'DL' })
  })

  it('setHistoryId persists the deltaLink to graphDeltaLink', async () => {
    await ports().setHistoryId('DL2')
    expect(store.updateGraphDeltaLink).toHaveBeenCalledWith('cred', 'DL2')
  })

  it('getThreadMessages parses a conversation', async () => {
    fetchMock.mockResolvedValueOnce(okJson({ value: [{ id: 'm', conversationId: 'c1', internetMessageId: '<x@y>', body: { contentType: 'text', content: 'hi' } }] }))
    const msgs = await ports().getThreadMessages('c1')
    expect(msgs[0].providerMessageId).toBe('msft:<x@y>')
  })

  it('reuses the shared persist ports (resolveContact → DB)', async () => {
    db.contactEmail.findMany.mockResolvedValue([])
    expect(await ports().resolveContact(['x@y.com'])).toBeNull()
    expect(db.contactEmail.findMany).toHaveBeenCalled()
  })

  it('delegates listThreadIds / upsertThread / saveMessages / emit', async () => {
    fetchMock.mockResolvedValue(okJson({ value: [{ conversationId: 'c1' }] }))
    db.emailThread.upsert.mockResolvedValue({ id: 't' })
    db.message.findMany.mockResolvedValue([])
    db.message.findUnique.mockResolvedValue({ id: 'db1' })
    const ps = ports()

    expect(await ps.listThreadIds('after:x')).toEqual(['c1'])
    expect(
      await ps.upsertThread({
        providerThreadId: 'msft:conv1',
        subject: 'S',
        participants: [],
        firstMessageAt: new Date(0),
        lastMessageAt: new Date(0),
        messageCount: 1,
        contactId: null,
        leadId: null,
      }),
    ).toEqual({ id: 't' })
    expect(await ps.saveMessages([])).toEqual({ insertedIds: [] })
    await ps.emitMessageReceived({
      providerMessageId: 'msft:<z>',
      channel: 'email',
      contactId: null,
      leadId: null,
    } as never)
    expect(events.notifyMessageReceived).toHaveBeenCalled()
  })
})
