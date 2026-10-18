import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { GraphClient, parseGraphMessage, type GraphMessage } from './graph-client'

const fetchMock = vi.fn()
const savedGraphEnabled = process.env.GRAPH_ENABLED
beforeEach(() => {
  vi.stubGlobal('fetch', fetchMock)
  fetchMock.mockReset()
  // Brief 41.2: Outlook is paused unless GRAPH_ENABLED is exactly 'true'. These
  // tests exercise the client against a mocked Graph, so they turn it on.
  process.env.GRAPH_ENABLED = 'true'
  process.env.GRAPH_API_BASE = 'https://graph.test/v1.0'
  delete process.env.GRAPH_MOCK_URL
})
afterEach(() => {
  vi.unstubAllGlobals()
  if (savedGraphEnabled === undefined) delete process.env.GRAPH_ENABLED
  else process.env.GRAPH_ENABLED = savedGraphEnabled
})

const okJson = (body: unknown) => ({ ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body) })

describe('parseGraphMessage', () => {
  it('normalizes a Graph message (dedup keys on internetMessageId / conversationId)', () => {
    const m: GraphMessage = {
      id: 'AAA',
      conversationId: 'conv1',
      internetMessageId: '<buyer-1@mail>',
      subject: 'Interested',
      receivedDateTime: '2026-08-08T15:00:00Z',
      from: { emailAddress: { address: 'Buyer@Example.com' } },
      toRecipients: [{ emailAddress: { address: 'ryan@elliman.com' } }],
      body: { contentType: 'html', content: '<p>hi</p>' },
    }
    const p = parseGraphMessage(m)
    expect(p.providerMessageId).toBe('msft:<buyer-1@mail>')
    expect(p.providerThreadId).toBe('msft:conv1')
    expect(p.fromAddress).toBe('buyer@example.com')
    expect(p.toAddresses).toEqual(['ryan@elliman.com'])
    expect(p.bodyHtml).toBe('<p>hi</p>')
    expect(p.date.toISOString()).toBe('2026-08-08T15:00:00.000Z')
  })

  it('falls back to id when internetMessageId is absent; text body', () => {
    const p = parseGraphMessage({ id: 'X', conversationId: 'c', body: { contentType: 'text', content: 't' } })
    expect(p.providerMessageId).toBe('msft:X')
    expect(p.bodyText).toBe('t')
  })
})

describe('GraphClient.listChangedConversations', () => {
  it('follows nextLink, dedups conversationIds, returns the deltaLink', async () => {
    fetchMock
      .mockResolvedValueOnce(okJson({ value: [{ conversationId: 'a' }, { conversationId: 'a' }], '@odata.nextLink': 'https://graph.test/next' }))
      .mockResolvedValueOnce(okJson({ value: [{ conversationId: 'b' }], '@odata.deltaLink': 'https://graph.test/delta?token=1' }))
    const r = await new GraphClient('AT').listChangedConversations('')
    expect(r.conversationIds.sort()).toEqual(['a', 'b'])
    expect(r.latestDeltaLink).toBe('https://graph.test/delta?token=1')
  })

  it('uses a provided deltaLink as the absolute URL', async () => {
    fetchMock.mockResolvedValueOnce(okJson({ value: [], '@odata.deltaLink': 'DL2' }))
    await new GraphClient('AT').listChangedConversations('https://graph.test/delta?token=1')
    expect(String(fetchMock.mock.calls[0][0])).toBe('https://graph.test/delta?token=1')
  })

  it('skips delta entries without a conversationId', async () => {
    fetchMock.mockResolvedValueOnce(okJson({ value: [{ conversationId: 'a' }, {}], '@odata.deltaLink': 'DL' }))
    expect((await new GraphClient('AT').listChangedConversations('')).conversationIds).toEqual(['a'])
  })
})

describe('GraphClient.getConversationMessages / listConversationsSince', () => {
  it('parses conversation messages', async () => {
    fetchMock.mockResolvedValueOnce(okJson({ value: [{ id: 'm', conversationId: 'c', internetMessageId: '<x@y>', body: { contentType: 'text', content: 'hi' } }] }))
    const msgs = await new GraphClient('AT').getConversationMessages('c')
    expect(msgs).toHaveLength(1)
    expect(msgs[0].providerMessageId).toBe('msft:<x@y>')
    expect(String(fetchMock.mock.calls[0][0])).toContain("conversationId%20eq%20'c'")
  })

  it('collects backfill conversation ids, skipping messages without one', async () => {
    fetchMock.mockResolvedValueOnce(okJson({ value: [{ conversationId: 'c1' }, {}, { conversationId: 'c2' }] }))
    expect((await new GraphClient('AT').listConversationsSince('')).sort()).toEqual(['c1', 'c2'])
  })

  it('throws on a non-2xx GET', async () => {
    fetchMock.mockResolvedValueOnce({ ok: false, status: 503, json: async () => ({}), text: async () => '' })
    await expect(new GraphClient('AT').getConversationMessages('c')).rejects.toThrow(/HTTP 503/)
  })
})

describe('GraphClient.createAndSend', () => {
  it('creates a draft with the internetMessageId then sends it', async () => {
    fetchMock
      .mockResolvedValueOnce(okJson({ id: 'draft1' })) // create
      .mockResolvedValueOnce({ ok: true, status: 202, json: async () => ({}), text: async () => '' }) // send
    await new GraphClient('AT').createAndSend({
      internetMessageId: '<crm-1@dealflow-crm.local>',
      body: { contentType: 'Text', content: 'hi' },
      toRecipients: [{ emailAddress: { address: 'a@b.com' } }],
    })
    expect(String(fetchMock.mock.calls[0][0])).toContain('/me/messages')
    expect(String(fetchMock.mock.calls[1][0])).toContain('/me/messages/draft1/send')
    const createdBody = JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string)
    expect(createdBody.internetMessageId).toBe('<crm-1@dealflow-crm.local>')
  })

  it('throws on a non-2xx', async () => {
    fetchMock.mockResolvedValueOnce({ ok: false, status: 500, json: async () => ({}), text: async () => '' })
    await expect(
      new GraphClient('AT').createAndSend({ internetMessageId: '<x>', body: { contentType: 'Text', content: '' }, toRecipients: [] }),
    ).rejects.toThrow(/HTTP 500/)
  })
})

// Brief 41.2 (PR D). Ryan's instruction: Outlook stays on hard pause; switch
// name confirmed by Ryan 2026-10-17. Every Graph request refuses before any
// HTTP call unless GRAPH_ENABLED is exactly 'true'. The client never reads
// EMAIL_ENABLED, so this holds whatever the email switch says.
describe.each([
  ['unset', undefined],
  ['empty', ''],
  ['TRUE', 'TRUE'],
  ['1', '1'],
])('while Outlook is paused (GRAPH_ENABLED %s)', (_n, value) => {
  const paused = { name: 'GraphDisabledError', code: 'outlook_paused' }
  beforeEach(() => {
    if (value === undefined) delete process.env.GRAPH_ENABLED
    else process.env.GRAPH_ENABLED = value
    fetchMock.mockResolvedValue(okJson({ id: 'draft1', value: [{ conversationId: 'c1' }], '@odata.deltaLink': 'DL' }))
  })

  it.each([
    ['createAndSend (send)', (gc: GraphClient) =>
      gc.createAndSend({ internetMessageId: '<crm-1@dealflow-crm.local>', body: { contentType: 'Text', content: 'hi' }, toRecipients: [{ emailAddress: { address: 'a@b.com' } }] })],
    ['listChangedConversations (sync)', (gc: GraphClient) => gc.listChangedConversations('')],
    ['getConversationMessages (sync)', (gc: GraphClient) => gc.getConversationMessages('c1')],
    ['listConversationsSince (backfill)', (gc: GraphClient) => gc.listConversationsSince('')],
  ])('%s refuses with no HTTP call', async (_name, call) => {
    await expect(call(new GraphClient('AT'))).rejects.toMatchObject(paused)
    expect(fetchMock).not.toHaveBeenCalled()
  })
})
