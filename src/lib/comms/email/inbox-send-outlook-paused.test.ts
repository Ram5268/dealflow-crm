import { describe, it, expect, vi, beforeAll, beforeEach, afterEach, afterAll } from 'vitest'
import { randomBytes } from 'node:crypto'

// Brief 41.2 (PR D): an inbox send (POST /api/comms/messages) whose only
// mailbox is Outlook, with EMAIL_ENABLED on (set for this test process only),
// while Outlook is paused. Ryan's instruction: Outlook stays on hard pause;
// switch name confirmed by Ryan 2026-10-17. It answers 403 with the plain
// message instead of a generic failure, and nothing reaches Microsoft. The real
// route and the real send path run; only Prisma and fetch are stubbed.
const db = vi.hoisted(() => ({
  message: { create: vi.fn(), findFirst: vi.fn(), findUnique: vi.fn(), update: vi.fn() },
  oAuthCredential: { findMany: vi.fn(), update: vi.fn() },
  $transaction: vi.fn(),
}))
vi.mock('@/lib/prisma', () => ({ prisma: db }))
vi.mock('@/lib/shell/orgContext', () => ({ getCurrentOrgId: async () => 'org_1' }))

import { POST } from '@/app/api/comms/messages/route'
import { encryptToken } from '@/lib/comms/oauth/crypto'

const ENV_KEYS = ['EMAIL_ENABLED', 'GRAPH_ENABLED', 'OAUTH_TOKEN_ENCRYPTION_KEY', 'GRAPH_API_BASE', 'GRAPH_MOCK_URL'] as const
const savedEnv = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]))
beforeAll(() => {
  process.env.OAUTH_TOKEN_ENCRYPTION_KEY = randomBytes(32).toString('base64')
  process.env.GRAPH_API_BASE = 'https://graph.test/v1.0'
  delete process.env.GRAPH_MOCK_URL
})
afterAll(() => {
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k]
    else process.env[k] = savedEnv[k]
  }
})

const fetchMock = vi.fn()
beforeEach(() => {
  vi.clearAllMocks()
  fetchMock.mockReset()
  vi.stubGlobal('fetch', fetchMock)
  process.env.EMAIL_ENABLED = 'true' // test-only: the case where email were switched on
  delete process.env.GRAPH_ENABLED
  db.message.create.mockResolvedValue({ id: 'm1' })
  db.message.findUnique.mockResolvedValue({
    id: 'm1',
    organizationId: 'org_1',
    channel: 'email',
    fromAddress: '',
    toAddresses: ['owner@example.com'],
    ccAddresses: [],
    bccAddresses: [],
    subject: 'Hi',
    bodyText: 'Hello',
    bodyHtml: null,
  })
  db.message.update.mockResolvedValue({})
  db.$transaction.mockImplementation(async (fn: (tx: unknown) => unknown) => fn(db))
  // The only connected mailbox is Outlook.
  db.oAuthCredential.findMany.mockResolvedValue([
    {
      id: 'cred-m',
      provider: 'msft-graph',
      emailAddress: 'broker@example.com',
      accessTokenEncrypted: encryptToken('AT'),
      refreshTokenEncrypted: null,
      expiresAt: new Date(Date.now() + 3_600_000),
    },
  ])
})
afterEach(() => vi.unstubAllGlobals())

const post = () =>
  POST(
    new Request('http://crm.test/api/comms/messages', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ channel: 'email', toAddresses: ['owner@example.com'], subject: 'Hi', bodyText: 'Hello' }),
    }),
  )

describe('Brief 41.2: inbox send through Outlook while Outlook is paused', () => {
  it.each([
    ['unset', undefined],
    ['empty', ''],
    ['TRUE', 'TRUE'],
    ['1', '1'],
  ])('GRAPH_ENABLED %s: 403 with the plain message, and no Microsoft call', async (_n, value) => {
    if (value !== undefined) process.env.GRAPH_ENABLED = value
    const res = await post()
    expect(res.status).toBe(403)
    expect(await res.json()).toEqual({
      messageId: 'm1',
      status: 'error',
      error: 'outlook_paused',
      message: expect.stringMatching(/^Outlook is paused/),
    })
    expect(fetchMock).not.toHaveBeenCalled()
    expect(db.oAuthCredential.update).not.toHaveBeenCalled()
    // As for any failed send, the saved message is marked as an error, so it
    // doesn't wait in the outbox.
    expect(db.message.update).toHaveBeenCalledTimes(1)
    expect(db.message.update).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 'm1' }, data: expect.objectContaining({ status: 'error' }) }),
    )
  })

  it('with GRAPH_ENABLED=true it sends through the (mocked) Graph as before', async () => {
    process.env.GRAPH_ENABLED = 'true'
    fetchMock
      .mockResolvedValueOnce({ ok: true, status: 201, json: async () => ({ id: 'draft1' }), text: async () => JSON.stringify({ id: 'draft1' }) })
      .mockResolvedValueOnce({ ok: true, status: 202, json: async () => ({}), text: async () => '' })
    const res = await post()
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ messageId: 'm1', status: 'sent' })
    expect(String(fetchMock.mock.calls[1][0])).toBe('https://graph.test/v1.0/me/messages/draft1/send')
  })
})
