import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest'
import { randomBytes } from 'node:crypto'

const db = vi.hoisted(() => ({
  message: { findUnique: vi.fn(), update: vi.fn() },
  oAuthCredential: { findMany: vi.fn(), update: vi.fn() },
  $transaction: vi.fn(),
}))
vi.mock('../../prisma', () => ({ prisma: db }))

const gmailOAuth = vi.hoisted(() => ({ refreshAccessToken: vi.fn() }))
const graphOAuth = vi.hoisted(() => ({ refreshAccessToken: vi.fn() }))
vi.mock('../oauth/gmail', () => gmailOAuth)
vi.mock('../oauth/graph', () => graphOAuth)

const gmailClientSend = vi.hoisted(() => ({ sendRaw: vi.fn() }))
const graphClientSend = vi.hoisted(() => ({ createAndSend: vi.fn() }))
vi.mock('./gmail-client', () => ({
  GmailClient: { forAccessToken: () => ({ sendRaw: gmailClientSend.sendRaw }) },
}))
vi.mock('./graph-client', () => ({
  GraphClient: class {
    createAndSend = graphClientSend.createAndSend
  },
}))

import { encryptToken } from '../oauth/crypto'
import { buildRawMessage, generateMessageId, sendEmailMessage, type ProviderSender } from './send'
import { emailEnabled, EmailDisabledError } from './config'

beforeAll(() => {
  process.env.OAUTH_TOKEN_ENCRYPTION_KEY = randomBytes(32).toString('base64')
})
beforeEach(() => {
  vi.clearAllMocks()
  process.env.EMAIL_ENABLED = 'true' // Brief 37: off by default; these tests exercise a live send
  db.$transaction.mockImplementation(async (fn: (tx: unknown) => unknown) => fn(db))
  db.message.update.mockResolvedValue({})
})

const decode = (b64: string) => Buffer.from(b64, 'base64url').toString('utf8')

const emailMsg = {
  id: 'm1',
  organizationId: 'o',
  channel: 'email',
  fromAddress: '',
  toAddresses: ['a@b.com'],
  ccAddresses: [],
  bccAddresses: [],
  subject: 'Hi',
  bodyText: 'yo',
  bodyHtml: null,
}

const gmailCred = () => ({
  id: 'cred-g',
  provider: 'gmail',
  emailAddress: 'ryan@gmail.com',
  accessTokenEncrypted: encryptToken('AT'),
  refreshTokenEncrypted: null,
  expiresAt: new Date(Date.now() + 3_600_000),
})
const msftCred = () => ({
  id: 'cred-m',
  provider: 'msft-graph',
  emailAddress: 'ryan@elliman.com',
  accessTokenEncrypted: encryptToken('AT'),
  refreshTokenEncrypted: null,
  expiresAt: new Date(Date.now() + 3_600_000),
})

describe('generateMessageId / buildRawMessage', () => {
  it('generates a crm-namespaced Message-ID', () => {
    expect(generateMessageId('abc')).toBe('<crm-abc@dealflow-crm.local>')
  })
  it('builds MIME with headers, Message-ID and multipart when html+text', () => {
    const raw = decode(
      buildRawMessage({ from: 'r@e.com', to: ['a@b.com'], subject: 'Hi', bodyText: 'plain', bodyHtml: '<p>rich</p>', messageId: '<crm-1@dealflow-crm.local>' }),
    )
    expect(raw).toContain('Message-ID: <crm-1@dealflow-crm.local>')
    expect(raw).toContain('multipart/alternative')
    expect(raw).toContain('<p>rich</p>')
  })
})

describe('sendEmailMessage provider routing', () => {
  it('routes to Gmail (gmail: prefix) and marks sent', async () => {
    db.message.findUnique.mockResolvedValue(emailMsg)
    db.oAuthCredential.findMany.mockResolvedValue([gmailCred()])
    const send: ProviderSender = vi.fn(async () => {})
    const res = await sendEmailMessage('m1', { send })

    expect(res.status).toBe('sent')
    expect(res.providerMessageId).toMatch(/^gmail:<crm-.+@dealflow-crm\.local>$/)
    expect((send as any).mock.calls[0][0].provider).toBe('gmail')
    // providerMessageId set before send (update #1), status after (update #2)
    expect(db.message.update).toHaveBeenCalledTimes(2)
    expect((db.message.update.mock.calls[1][0] as any).data.status).toBe('sent')
  })

  it('routes to Graph (msft: prefix) when only a msft-graph credential exists', async () => {
    db.message.findUnique.mockResolvedValue(emailMsg)
    db.oAuthCredential.findMany.mockResolvedValue([msftCred()])
    const send: ProviderSender = vi.fn(async () => {})
    const res = await sendEmailMessage('m1', { send })

    expect(res.providerMessageId).toMatch(/^msft:<crm-.+@dealflow-crm\.local>$/)
    expect((send as any).mock.calls[0][0].provider).toBe('msft-graph')
  })

  it('prefers Gmail when both providers are connected', async () => {
    db.message.findUnique.mockResolvedValue(emailMsg)
    db.oAuthCredential.findMany.mockResolvedValue([msftCred(), gmailCred()])
    const send: ProviderSender = vi.fn(async () => {})
    const res = await sendEmailMessage('m1', { send })
    expect(res.providerMessageId.startsWith('gmail:')).toBe(true)
  })

  it('picks the credential matching the message fromAddress', async () => {
    // fromAddress matches the msft credential, overriding the gmail preference.
    db.message.findUnique.mockResolvedValue({ ...emailMsg, fromAddress: 'ryan@elliman.com' })
    db.oAuthCredential.findMany.mockResolvedValue([gmailCred(), msftCred()])
    const send: ProviderSender = vi.fn(async () => {})
    const res = await sendEmailMessage('m1', { send })
    expect(res.providerMessageId.startsWith('msft:')).toBe(true)
  })

  it('refreshes an expired token with the provider-appropriate refresh', async () => {
    db.message.findUnique.mockResolvedValue(emailMsg)
    db.oAuthCredential.findMany.mockResolvedValue([
      { ...msftCred(), refreshTokenEncrypted: encryptToken('RT'), expiresAt: new Date(Date.now() - 1000) },
    ])
    db.oAuthCredential.update.mockResolvedValue({})
    graphOAuth.refreshAccessToken.mockResolvedValue({ accessToken: 'AT-new', expiresAt: new Date(Date.now() + 3_600_000) })
    const send: ProviderSender = vi.fn(async () => {})

    await sendEmailMessage('m1', { send })
    expect(graphOAuth.refreshAccessToken).toHaveBeenCalledWith('RT')
    expect(gmailOAuth.refreshAccessToken).not.toHaveBeenCalled()
    expect(db.oAuthCredential.update).toHaveBeenCalled()
  })

  it('throws when there is no active credential', async () => {
    db.message.findUnique.mockResolvedValue(emailMsg)
    db.oAuthCredential.findMany.mockResolvedValue([])
    await expect(sendEmailMessage('m1', { send: vi.fn() })).rejects.toThrow(/no active email credential/)
  })

  it('leaves status unset for retry when the provider send fails', async () => {
    db.message.findUnique.mockResolvedValue(emailMsg)
    db.oAuthCredential.findMany.mockResolvedValue([gmailCred()])
    const send: ProviderSender = vi.fn(async () => {
      throw new Error('provider 500')
    })
    await expect(sendEmailMessage('m1', { send })).rejects.toThrow('provider 500')
    expect(db.message.update).toHaveBeenCalledTimes(1) // only providerMessageId set
  })
})

describe('defaultSend (real provider dispatch)', () => {
  it('gmail: builds MIME carrying the Message-ID and calls GmailClient.sendRaw', async () => {
    db.message.findUnique.mockResolvedValue(emailMsg)
    db.oAuthCredential.findMany.mockResolvedValue([gmailCred()])
    gmailClientSend.sendRaw.mockResolvedValue('id')
    const res = await sendEmailMessage('m1')
    expect(gmailClientSend.sendRaw).toHaveBeenCalledOnce()
    const raw = decode(gmailClientSend.sendRaw.mock.calls[0][0] as string)
    expect(raw).toContain(`Message-ID: ${res.providerMessageId.replace('gmail:', '')}`)
  })

  it('graph: calls GraphClient.createAndSend with the internetMessageId + recipients', async () => {
    db.message.findUnique.mockResolvedValue({
      ...emailMsg,
      bodyHtml: '<p>h</p>',
      ccAddresses: ['cc@x.com'],
      bccAddresses: ['bcc@x.com'],
    })
    db.oAuthCredential.findMany.mockResolvedValue([msftCred()])
    graphClientSend.createAndSend.mockResolvedValue(undefined)
    const res = await sendEmailMessage('m1')
    expect(graphClientSend.createAndSend).toHaveBeenCalledOnce()
    const gm = graphClientSend.createAndSend.mock.calls[0][0] as any
    expect(gm.internetMessageId).toBe(res.providerMessageId.replace('msft:', ''))
    expect(gm.body.contentType).toBe('HTML')
    expect(gm.ccRecipients).toEqual([{ emailAddress: { address: 'cc@x.com' } }])
    expect(gm.bccRecipients).toEqual([{ emailAddress: { address: 'bcc@x.com' } }])
  })

  it('graph text-only send uses Text contentType', async () => {
    db.message.findUnique.mockResolvedValue({ ...emailMsg, bodyHtml: null })
    db.oAuthCredential.findMany.mockResolvedValue([msftCred()])
    graphClientSend.createAndSend.mockResolvedValue(undefined)
    await sendEmailMessage('m1')
    expect((graphClientSend.createAndSend.mock.calls[0][0] as any).body.contentType).toBe('Text')
  })
})

describe('Brief 37: EMAIL_ENABLED switch', () => {
  it('refuses while email is off — no message read, no token refresh, no send', async () => {
    delete process.env.EMAIL_ENABLED
    const send = vi.fn() as unknown as ProviderSender
    await expect(sendEmailMessage('m1', { send })).rejects.toBeInstanceOf(EmailDisabledError)
    expect(db.message.findUnique).not.toHaveBeenCalled()
    expect(db.oAuthCredential.findMany).not.toHaveBeenCalled()
    expect(gmailOAuth.refreshAccessToken).not.toHaveBeenCalled()
    expect(send).not.toHaveBeenCalled()
  })

  it('is on only for the exact string "true"', () => {
    expect(emailEnabled({ EMAIL_ENABLED: 'true' })).toBe(true)
    for (const v of [undefined, '', 'false', '1', 'TRUE', 'yes', ' true']) {
      expect(emailEnabled({ EMAIL_ENABLED: v })).toBe(false)
    }
  })
})
