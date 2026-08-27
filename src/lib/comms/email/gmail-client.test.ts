import { describe, it, expect, vi } from 'vitest'
import { GmailClient } from './gmail-client'

// A structural fake of the googleapis gmail_v1.Gmail surface GmailClient uses.
function fakeGmail(overrides: Record<string, unknown> = {}) {
  return {
    users: {
      threads: {
        list: vi.fn(),
        get: vi.fn(),
      },
      history: { list: vi.fn() },
      messages: { send: vi.fn() },
      watch: vi.fn(),
      ...overrides,
    },
  }
}

function client(gmail: ReturnType<typeof fakeGmail>) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return new GmailClient(gmail as any)
}

describe('GmailClient.listThreadIds', () => {
  it('follows pagination and flattens thread ids', async () => {
    const g = fakeGmail()
    g.users.threads.list
      .mockResolvedValueOnce({ data: { threads: [{ id: 't1' }, { id: 't2' }], nextPageToken: 'p2' } })
      .mockResolvedValueOnce({ data: { threads: [{ id: 't3' }], nextPageToken: null } })
    const ids = await client(g).listThreadIds('after:2026/08/01')
    expect(ids).toEqual(['t1', 't2', 't3'])
    expect(g.users.threads.list).toHaveBeenCalledTimes(2)
  })

  it('returns [] when there are no threads', async () => {
    const g = fakeGmail()
    g.users.threads.list.mockResolvedValue({ data: {} })
    expect(await client(g).listThreadIds('q')).toEqual([])
  })
})

describe('GmailClient.getThreadMessages', () => {
  it('parses each raw message', async () => {
    const g = fakeGmail()
    g.users.threads.get.mockResolvedValue({
      data: {
        messages: [
          {
            id: 'm1',
            threadId: 't1',
            internalDate: '1786000000000',
            payload: { headers: [{ name: 'From', value: 'a@b.com' }, { name: 'Message-ID', value: '<x@y>' }] },
          },
        ],
      },
    })
    const parsed = await client(g).getThreadMessages('t1')
    expect(parsed).toHaveLength(1)
    expect(parsed[0].fromAddress).toBe('a@b.com')
    expect(parsed[0].providerMessageId).toBe('gmail:<x@y>')
  })

  it('returns [] for an empty thread', async () => {
    const g = fakeGmail()
    g.users.threads.get.mockResolvedValue({ data: {} })
    expect(await client(g).getThreadMessages('t1')).toEqual([])
  })
})

describe('GmailClient.listChangedThreadIds', () => {
  it('dedups added thread ids across history pages and returns the latest historyId', async () => {
    const g = fakeGmail()
    g.users.history.list
      .mockResolvedValueOnce({
        data: {
          history: [{ messagesAdded: [{ message: { id: 'm1', threadId: 'tA' } }, { message: { id: 'm2', threadId: 'tA' } }] }],
          nextPageToken: 'p2',
          historyId: '10',
        },
      })
      .mockResolvedValueOnce({
        data: { history: [{ messagesAdded: [{ message: { id: 'm3', threadId: 'tB' } }] }], historyId: '20' },
      })
    const { threadIds, latestHistoryId } = await client(g).listChangedThreadIds('1')
    expect(threadIds.sort()).toEqual(['tA', 'tB'])
    expect(latestHistoryId).toBe('20')
  })
})

describe('GmailClient.sendRaw / watch', () => {
  it('sendRaw returns the new message id', async () => {
    const g = fakeGmail()
    g.users.messages.send.mockResolvedValue({ data: { id: 'sent1' } })
    expect(await client(g).sendRaw('cmF3')).toBe('sent1')
    expect(g.users.messages.send).toHaveBeenCalledWith({
      userId: 'me',
      requestBody: { raw: 'cmF3' },
    })
  })

  it('watch returns historyId + expiration', async () => {
    const g = fakeGmail()
    g.users.watch.mockResolvedValue({ data: { historyId: '100', expiration: '123' } })
    expect(await client(g).watch('projects/x/topics/y')).toEqual({
      historyId: '100',
      expiration: '123',
    })
  })

  it('sendRaw / watch return undefined fields when absent', async () => {
    const g = fakeGmail()
    g.users.messages.send.mockResolvedValue({ data: {} })
    g.users.watch.mockResolvedValue({ data: {} })
    expect(await client(g).sendRaw('x')).toBeUndefined()
    expect(await client(g).watch('t')).toEqual({ historyId: undefined, expiration: undefined })
  })

  it('listChangedThreadIds handles empty history', async () => {
    const g = fakeGmail()
    g.users.history.list.mockResolvedValue({ data: {} })
    expect(await client(g).listChangedThreadIds('1')).toEqual({
      threadIds: [],
      latestHistoryId: undefined,
    })
  })
})
