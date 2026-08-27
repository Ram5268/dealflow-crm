import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest'
import { randomBytes } from 'node:crypto'

const db = vi.hoisted(() => ({
  message: { findUnique: vi.fn(), update: vi.fn() },
  oAuthCredential: { findUnique: vi.fn(), update: vi.fn() },
  $transaction: vi.fn(),
}))
vi.mock('../../prisma', () => ({ prisma: db }))

const gmailOAuth = vi.hoisted(() => ({ refreshAccessToken: vi.fn() }))
vi.mock('../oauth/gmail', () => gmailOAuth)

import { encryptToken } from '../oauth/crypto'
import { buildRawMessage, generateMessageId, sendEmailMessage } from './send'

beforeAll(() => {
  process.env.OAUTH_TOKEN_ENCRYPTION_KEY = randomBytes(32).toString('base64')
})
beforeEach(() => {
  vi.clearAllMocks()
  db.$transaction.mockImplementation(async (fn: (tx: unknown) => unknown) => fn(db))
})

function decode(rawB64: string): string {
  return Buffer.from(rawB64, 'base64url').toString('utf8')
}

describe('generateMessageId', () => {
  it('produces a crm-namespaced RFC5322 Message-ID', () => {
    expect(generateMessageId('abc')).toBe('<crm-abc@dealflow-crm.local>')
  })
})

describe('buildRawMessage', () => {
  it('emits headers + the client Message-ID + text body', () => {
    const raw = decode(
      buildRawMessage({
        from: 'ryan@e.com',
        to: ['a@b.com', 'c@d.com'],
        subject: 'Hi',
        bodyText: 'hello',
        messageId: '<crm-1@dealflow-crm.local>',
      }),
    )
    expect(raw).toContain('From: ryan@e.com')
    expect(raw).toContain('To: a@b.com, c@d.com')
    expect(raw).toContain('Subject: Hi')
    expect(raw).toContain('Message-ID: <crm-1@dealflow-crm.local>')
    expect(raw).toContain('hello')
  })

  it('builds multipart/alternative when html + text are both present', () => {
    const raw = decode(
      buildRawMessage({
        from: 'r@e.com',
        to: ['a@b.com'],
        bodyText: 'plain',
        bodyHtml: '<p>rich</p>',
        messageId: '<crm-2@dealflow-crm.local>',
      }),
    )
    expect(raw).toContain('multipart/alternative')
    expect(raw).toContain('plain')
    expect(raw).toContain('<p>rich</p>')
  })
})

const emailMsg = {
  id: 'm1',
  organizationId: 'o',
  channel: 'email',
  fromAddress: 'ryan@e.com',
  toAddresses: ['a@b.com'],
  ccAddresses: [],
  bccAddresses: [],
  subject: 'Hi',
  bodyText: 'yo',
  bodyHtml: null,
}

function credential() {
  return {
    id: 'cred1',
    emailAddress: 'ryan@e.com',
    accessTokenEncrypted: encryptToken('AT'),
    refreshTokenEncrypted: null,
    expiresAt: new Date(Date.now() + 3_600_000),
  }
}

describe('sendEmailMessage', () => {
  it('pre-sets providerMessageId (dedup) before sending, then marks sent', async () => {
    db.message.findUnique.mockResolvedValue(emailMsg)
    db.oAuthCredential.findUnique.mockResolvedValue(credential())
    db.message.update.mockResolvedValue({})

    const sender = vi.fn(async (_raw: string) => {})
    const res = await sendEmailMessage('m1', { sender, now: new Date('2026-08-27T00:00:00Z') })

    expect(res.status).toBe('sent')
    expect(res.providerMessageId).toMatch(/^gmail:<crm-.+@dealflow-crm\.local>$/)

    // First update sets providerMessageId; second sets status='sent'.
    expect(db.message.update).toHaveBeenCalledTimes(2)
    expect((db.message.update.mock.calls[0][0] as any).data.providerMessageId).toBe(
      res.providerMessageId,
    )
    expect((db.message.update.mock.calls[1][0] as any).data.status).toBe('sent')

    // The sent MIME carries the same Message-ID → sent-copy dedup will match.
    const raw = decode(sender.mock.calls[0][0] as string)
    expect(raw).toContain(`Message-ID: ${res.providerMessageId.replace('gmail:', '')}`)
  })

  it('leaves status unset (for retry) when the provider send fails', async () => {
    db.message.findUnique.mockResolvedValue(emailMsg)
    db.oAuthCredential.findUnique.mockResolvedValue(credential())
    db.message.update.mockResolvedValue({})

    const sender = vi.fn(async () => {
      throw new Error('gmail 500')
    })
    await expect(sendEmailMessage('m1', { sender })).rejects.toThrow('gmail 500')
    // providerMessageId was set (1 update); status='sent' never happened.
    expect(db.message.update).toHaveBeenCalledTimes(1)
  })

  it('throws when there is no Gmail credential', async () => {
    db.message.findUnique.mockResolvedValue(emailMsg)
    db.oAuthCredential.findUnique.mockResolvedValue(null)
    await expect(sendEmailMessage('m1', { sender: vi.fn() })).rejects.toThrow(/no active Gmail credential/)
  })

  it('refreshes an expired access token before sending', async () => {
    db.message.findUnique.mockResolvedValue(emailMsg)
    db.oAuthCredential.findUnique.mockResolvedValue({
      id: 'cred1',
      emailAddress: 'ryan@e.com',
      accessTokenEncrypted: encryptToken('AT-old'),
      refreshTokenEncrypted: encryptToken('RT'),
      expiresAt: new Date(Date.now() - 1000), // expired
    })
    db.oAuthCredential.update.mockResolvedValue({})
    db.message.update.mockResolvedValue({})
    gmailOAuth.refreshAccessToken.mockResolvedValue({
      accessToken: 'AT-new',
      expiresAt: new Date(Date.now() + 3_600_000),
    })

    const sender = vi.fn(async (_raw: string) => {})
    const res = await sendEmailMessage('m1', { sender })
    expect(gmailOAuth.refreshAccessToken).toHaveBeenCalledWith('RT')
    expect(db.oAuthCredential.update).toHaveBeenCalled()
    expect(res.status).toBe('sent')
  })
})
