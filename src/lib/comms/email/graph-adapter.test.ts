import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

const db = vi.hoisted(() => ({
  contactEmail: { findMany: vi.fn() },
  message: { findMany: vi.fn(), createMany: vi.fn(), findUnique: vi.fn() },
  emailThread: { upsert: vi.fn() },
}))
const store = vi.hoisted(() => ({ updateGraphDeltaLink: vi.fn(), updateGmailHistoryId: vi.fn() }))
const events = vi.hoisted(() => ({ notifyMessageReceived: vi.fn() }))
const activity = vi.hoisted(() => ({ recordMessageReceivedSafely: vi.fn() }))
vi.mock('../../prisma', () => ({ prisma: db }))
vi.mock('../oauth/store', () => store)
vi.mock('../events', () => events)
vi.mock('../../core-data/activity/write', () => activity)

import { createGraphSyncPorts } from './graph-adapter'

const fetchMock = vi.fn()
const savedGraphEnabled = process.env.GRAPH_ENABLED
beforeEach(() => {
  vi.clearAllMocks()
  vi.stubGlobal('fetch', fetchMock)
  // Brief 41.2: Outlook is paused unless GRAPH_ENABLED is exactly 'true'. These
  // tests exercise the sync ports against a mocked Graph, so they turn it on.
  process.env.GRAPH_ENABLED = 'true'
  process.env.GRAPH_API_BASE = 'https://graph.test/v1.0'
  delete process.env.GRAPH_MOCK_URL
})
afterEach(() => {
  vi.unstubAllGlobals()
  if (savedGraphEnabled === undefined) delete process.env.GRAPH_ENABLED
  else process.env.GRAPH_ENABLED = savedGraphEnabled
})

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
    expect(activity.recordMessageReceivedSafely).toHaveBeenCalled() // Brief 50 (PR 3): timeline entry
  })
})

// Brief 41.2 (PR D). Ryan's instruction: Outlook stays on hard pause; switch
// name confirmed by Ryan 2026-10-17. No Outlook sync ports unless
// GRAPH_ENABLED is exactly 'true': nothing is read from Microsoft or saved.
describe.each([
  ['unset', undefined],
  ['empty', ''],
  ['TRUE', 'TRUE'],
  ['1', '1'],
])('while Outlook is paused (GRAPH_ENABLED %s)', (_n, value) => {
  it('createGraphSyncPorts refuses, with no HTTP call and no cursor saved', () => {
    if (value === undefined) delete process.env.GRAPH_ENABLED
    else process.env.GRAPH_ENABLED = value
    fetchMock.mockResolvedValue(okJson({ value: [{ conversationId: 'c1' }], '@odata.deltaLink': 'DL' }))
    let thrown: unknown
    try {
      ports()
    } catch (err) {
      thrown = err
    }
    expect(thrown).toMatchObject({ name: 'GraphDisabledError', code: 'outlook_paused' })
    expect(fetchMock).not.toHaveBeenCalled()
    expect(store.updateGraphDeltaLink).not.toHaveBeenCalled()
  })
})
