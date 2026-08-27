import { describe, it, expect } from 'vitest'
import {
  extractAddresses,
  firstAddress,
  headersToMap,
  decodeBody,
  parseGmailMessage,
  type GmailMessageLike,
} from './parse'

const b64url = (s: string) => Buffer.from(s).toString('base64url')

describe('extractAddresses', () => {
  it('parses bracketed + bare, lowercases, dedupes, ignores quoted-comma display names', () => {
    const v = 'John Doe <John@X.com>, "Doe, Jane" <jane@y.com>, bare@z.com, John@X.com'
    expect(extractAddresses(v)).toEqual(['john@x.com', 'jane@y.com', 'bare@z.com'])
  })

  it('returns [] for empty/undefined', () => {
    expect(extractAddresses(undefined)).toEqual([])
    expect(extractAddresses('')).toEqual([])
  })

  it('firstAddress returns the first or ""', () => {
    expect(firstAddress('A <a@b.com>, c@d.com')).toBe('a@b.com')
    expect(firstAddress(undefined)).toBe('')
  })
})

describe('headersToMap', () => {
  it('lowercases keys and keeps first occurrence', () => {
    const map = headersToMap([
      { name: 'From', value: 'a@b.com' },
      { name: 'Subject', value: 'Hi' },
      { name: 'Subject', value: 'ignored second' },
    ])
    expect(map['from']).toBe('a@b.com')
    expect(map['subject']).toBe('Hi')
  })
})

describe('decodeBody', () => {
  it('decodes base64url', () => {
    expect(decodeBody(b64url('Hello, world ☕'))).toBe('Hello, world ☕')
    expect(decodeBody(undefined)).toBe('')
  })
})

describe('parseGmailMessage', () => {
  const msg: GmailMessageLike = {
    id: 'abc123',
    threadId: 'thread9',
    internalDate: String(Date.UTC(2026, 7, 8, 19, 0, 0)), // 2026-08-08T19:00:00Z
    payload: {
      mimeType: 'multipart/alternative',
      headers: [
        { name: 'From', value: 'Ryan Martin <ryan@elliman.com>' },
        { name: 'To', value: 'Alice <alice@example.com>, bob@example.com' },
        { name: 'Cc', value: 'cc@example.com' },
        { name: 'Subject', value: 'Coming soon on your block' },
        { name: 'Message-ID', value: '<m-1@mail.gmail.com>' },
        { name: 'In-Reply-To', value: '<m-0@mail.gmail.com>' },
        { name: 'References', value: '<m-a@x> <m-b@x>\t<m-0@mail.gmail.com>' },
      ],
      parts: [
        { mimeType: 'text/plain', body: { data: b64url('plain body') } },
        { mimeType: 'text/html', body: { data: b64url('<p>html body</p>') } },
      ],
    },
  }

  it('normalizes headers, addresses, thread/message ids, bodies, and date', () => {
    const p = parseGmailMessage(msg)
    // providerMessageId keys on the Message-ID header (dedup design), not the API id.
    expect(p.providerMessageId).toBe('gmail:<m-1@mail.gmail.com>')
    expect(p.providerThreadId).toBe('gmail:thread9')
    expect(p.fromAddress).toBe('ryan@elliman.com')
    expect(p.toAddresses).toEqual(['alice@example.com', 'bob@example.com'])
    expect(p.ccAddresses).toEqual(['cc@example.com'])
    expect(p.subject).toBe('Coming soon on your block')
    expect(p.messageIdHeader).toBe('<m-1@mail.gmail.com>')
    expect(p.inReplyTo).toBe('<m-0@mail.gmail.com>')
    expect(p.references).toEqual(['<m-a@x>', '<m-b@x>', '<m-0@mail.gmail.com>'])
    expect(p.bodyText).toBe('plain body')
    expect(p.bodyHtml).toBe('<p>html body</p>')
    expect(p.date.toISOString()).toBe('2026-08-08T19:00:00.000Z')
  })

  it('falls back to the Date header when internalDate is absent', () => {
    const p = parseGmailMessage({
      id: 'x',
      threadId: 't',
      payload: { headers: [{ name: 'Date', value: 'Sat, 08 Aug 2026 19:00:00 +0000' }] },
    })
    expect(p.date.toISOString()).toBe('2026-08-08T19:00:00.000Z')
    expect(p.references).toEqual([])
    expect(p.bodyText).toBeUndefined()
  })

  it('collects bodies from nested multipart parts, ignores non-text parts', () => {
    const p = parseGmailMessage({
      id: 'x',
      threadId: 't',
      payload: {
        mimeType: 'multipart/mixed',
        parts: [
          {
            mimeType: 'multipart/alternative',
            parts: [
              { mimeType: 'text/plain', body: { data: b64url('nested plain') } },
              { mimeType: 'text/html', body: { data: b64url('<p>nested</p>') } },
            ],
          },
          { mimeType: 'application/pdf', filename: 'a.pdf', body: {} },
        ],
      },
    })
    expect(p.bodyText).toBe('nested plain')
    expect(p.bodyHtml).toBe('<p>nested</p>')
  })

  it('handles a text part with no body data', () => {
    const p = parseGmailMessage({ id: 'x', threadId: 't', payload: { mimeType: 'text/plain', body: {} } })
    expect(p.bodyText).toBeUndefined()
  })

  it('has no id → empty providerMessageId suffix (defensive)', () => {
    const p = parseGmailMessage({ threadId: 't', payload: {} })
    expect(p.providerMessageId).toBe('gmail:')
    expect(p.date.getTime()).toBe(0)
  })
})
