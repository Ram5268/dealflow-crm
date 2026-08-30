import { describe, it, expect } from 'vitest'
import {
  buildThreadSummaries,
  messageThreadKey,
  voicemailThreadKey,
  type GroupableMessage,
  type GroupableVoicemail,
} from '@/lib/inbox/threads'
import { isInboxFilter, threadMatchesFilter, type ThreadSummary } from '@/lib/inbox/types'

const NAMES = new Map([['lead_1', 'Dana Whitfield']])

function msg(over: Partial<GroupableMessage> & Pick<GroupableMessage, 'id' | 'activityAt'>): GroupableMessage {
  return {
    threadId: null,
    leadId: 'lead_1',
    channel: 'email',
    direction: 'incoming',
    fromAddress: 'dana@example.com',
    subject: 'Walkthrough',
    bodyText: 'Thursday works.',
    readAt: null,
    ...over,
  }
}

describe('messageThreadKey / voicemailThreadKey', () => {
  it('namespaces so a message thread cannot collide with a voicemail', () => {
    expect(messageThreadKey({ threadId: 'abc', id: 'm1' })).toBe('m:abc')
    expect(voicemailThreadKey('abc')).toBe('v:abc')
  })

  it('falls back to the message id when the message has no thread', () => {
    expect(messageThreadKey({ threadId: null, id: 'm1' })).toBe('m:m1')
  })
})

describe('buildThreadSummaries', () => {
  it('collapses messages that share a threadId into one row', () => {
    const out = buildThreadSummaries(
      [
        msg({ id: 'm2', threadId: 't1', activityAt: new Date('2026-08-29T12:00:00Z') }),
        msg({ id: 'm1', threadId: 't1', activityAt: new Date('2026-08-28T12:00:00Z') }),
      ],
      [],
      NAMES,
    )
    expect(out).toHaveLength(1)
    expect(out[0].messageCount).toBe(2)
    expect(out[0].messageIds).toEqual(['m2', 'm1'])
  })

  it('lets the NEWEST message represent the thread', () => {
    const out = buildThreadSummaries(
      [
        msg({ id: 'm2', threadId: 't1', subject: 'Newest', activityAt: new Date('2026-08-29T12:00:00Z') }),
        msg({ id: 'm1', threadId: 't1', subject: 'Oldest', activityAt: new Date('2026-08-28T12:00:00Z') }),
      ],
      [],
      NAMES,
    )
    expect(out[0].subject).toBe('Newest')
    expect(out[0].at).toBe('2026-08-29T12:00:00.000Z')
  })

  it('counts only unread INCOMING messages', () => {
    const out = buildThreadSummaries(
      [
        msg({ id: 'm3', threadId: 't1', direction: 'outgoing', activityAt: new Date('2026-08-29T13:00:00Z') }),
        msg({ id: 'm2', threadId: 't1', activityAt: new Date('2026-08-29T12:00:00Z') }),
        msg({ id: 'm1', threadId: 't1', readAt: new Date('2026-08-29T11:30:00Z'), activityAt: new Date('2026-08-29T11:00:00Z') }),
      ],
      [],
      NAMES,
    )
    // m2 unread; m1 already read; m3 outgoing and therefore never unread.
    expect(out[0].unreadCount).toBe(1)
    expect(out[0].unreadIds).toEqual(['m2'])
    expect(out[0].incomingIds).toEqual(['m2', 'm1'])
  })

  it('names a thread after its lead, falling back to the sender address', () => {
    const [withLead, withoutLead] = buildThreadSummaries(
      [
        msg({ id: 'm1', activityAt: new Date('2026-08-29T12:00:00Z') }),
        msg({ id: 'm2', leadId: null, fromAddress: 'stranger@example.com', activityAt: new Date('2026-08-28T12:00:00Z') }),
      ],
      [],
      NAMES,
    )
    expect(withLead.title).toBe('Dana Whitfield')
    expect(withoutLead.title).toBe('stranger@example.com')
  })

  it('interleaves voicemails into the same newest-first ordering', () => {
    const vm: GroupableVoicemail = {
      id: 'call_1',
      leadId: 'lead_1',
      remotePhone: '+12125550101',
      activityAt: new Date('2026-08-29T13:00:00Z'),
      voicemailDurationSec: 24,
    }
    const out = buildThreadSummaries(
      [msg({ id: 'm1', activityAt: new Date('2026-08-29T12:00:00Z') })],
      [vm],
      NAMES,
    )
    expect(out.map((t) => t.key)).toEqual(['v:call_1', 'm:m1'])
    expect(out[0].preview).toBe('Voicemail · 24s')
  })

  it('never lets a voicemail claim unread state — Call has no readAt', () => {
    const out = buildThreadSummaries(
      [],
      [{ id: 'c1', leadId: null, remotePhone: '+12125550101', activityAt: new Date(), voicemailDurationSec: null }],
      NAMES,
    )
    expect(out[0].unreadCount).toBe(0)
    expect(out[0].messageIds).toEqual([])
    expect(out[0].preview).toBe('Voicemail')
  })

  it('uses the subject when the body is empty', () => {
    const out = buildThreadSummaries(
      [msg({ id: 'm1', bodyText: null, subject: 'Just a subject', activityAt: new Date() })],
      [],
      NAMES,
    )
    expect(out[0].preview).toBe('Just a subject')
  })
})

describe('threadMatchesFilter', () => {
  const base: ThreadSummary = {
    key: 'm:1', channel: 'email', leadId: null, title: 'x', subject: null,
    preview: '', at: '2026-08-29T12:00:00.000Z', unreadCount: 0, messageCount: 1,
    messageIds: ['1'], incomingIds: ['1'], unreadIds: [],
  }

  it('all matches everything', () => {
    expect(threadMatchesFilter(base, 'all')).toBe(true)
    expect(threadMatchesFilter({ ...base, channel: 'voicemail' }, 'all')).toBe(true)
  })

  it('unread matches only threads with unread messages', () => {
    expect(threadMatchesFilter(base, 'unread')).toBe(false)
    expect(threadMatchesFilter({ ...base, unreadCount: 2 }, 'unread')).toBe(true)
  })

  it('channel filters match on channel', () => {
    expect(threadMatchesFilter(base, 'email')).toBe(true)
    expect(threadMatchesFilter(base, 'sms')).toBe(false)
    expect(threadMatchesFilter({ ...base, channel: 'sms' }, 'sms')).toBe(true)
    expect(threadMatchesFilter({ ...base, channel: 'voicemail' }, 'voicemail')).toBe(true)
  })
})

describe('isInboxFilter', () => {
  it('accepts the five known tabs and rejects anything else', () => {
    for (const f of ['all', 'unread', 'email', 'sms', 'voicemail']) {
      expect(isInboxFilter(f)).toBe(true)
    }
    expect(isInboxFilter('archived')).toBe(false)
    expect(isInboxFilter(undefined)).toBe(false)
    expect(isInboxFilter(null)).toBe(false)
  })
})
