import { describe, it, expect } from 'vitest'
import {
  aggregateThread,
  directionFor,
  type ContactResolver,
} from './thread-reconstruct'
import type { ParsedEmail } from './parse'

function mk(p: {
  id: string
  threadId?: string
  from: string
  to?: string[]
  cc?: string[]
  subject?: string
  date: string
}): ParsedEmail {
  return {
    providerMessageId: `gmail:${p.id}`,
    providerThreadId: `gmail:${p.threadId ?? 't1'}`,
    references: [],
    fromAddress: p.from,
    toAddresses: p.to ?? [],
    ccAddresses: p.cc ?? [],
    bccAddresses: [],
    subject: p.subject,
    date: new Date(p.date),
  }
}

const RYAN = 'ryan@elliman.com'

// Resolver keyed to a fixed contact book; returns the earliest-appearing match.
const contacts: Record<string, { contactId: string; leadId: string }> = {
  'alice@example.com': { contactId: 'cA', leadId: 'lA' },
  'bob@example.com': { contactId: 'cB', leadId: 'lB' },
}
const resolver: ContactResolver = (emails) => {
  for (const e of emails) if (contacts[e]) return contacts[e]
  return null
}
const noMatch: ContactResolver = () => null

describe('aggregateThread', () => {
  it('simple reply chain: 3 messages, 2 participants, first-message subject + date span', () => {
    const msgs = [
      mk({ id: 'm1', from: RYAN, to: ['alice@example.com'], subject: 'Coming soon', date: '2026-08-08T10:00:00Z' }),
      mk({ id: 'm2', from: 'alice@example.com', to: [RYAN], subject: 'Re: Coming soon', date: '2026-08-08T11:00:00Z' }),
      mk({ id: 'm3', from: RYAN, to: ['alice@example.com'], subject: 'Re: Coming soon', date: '2026-08-08T12:00:00Z' }),
    ]
    const agg = aggregateThread(msgs, resolver)
    expect(agg.messageCount).toBe(3)
    expect(agg.participants).toEqual([RYAN, 'alice@example.com'])
    expect(agg.subject).toBe('Coming soon')
    expect(agg.firstMessageAt.toISOString()).toBe('2026-08-08T10:00:00.000Z')
    expect(agg.lastMessageAt.toISOString()).toBe('2026-08-08T12:00:00.000Z')
    expect(agg.contactId).toBe('cA')
    expect(agg.leadId).toBe('lA')
  })

  it('forward stays in the same thread; subject is the original, new recipient joins participants', () => {
    const msgs = [
      mk({ id: 'm1', threadId: 't2', from: RYAN, to: ['alice@example.com'], subject: 'Listing packet', date: '2026-08-08T10:00:00Z' }),
      mk({ id: 'm2', threadId: 't2', from: RYAN, to: ['carol@new.com'], subject: 'Fwd: Listing packet', date: '2026-08-08T11:00:00Z' }),
    ]
    const agg = aggregateThread(msgs, resolver)
    expect(agg.subject).toBe('Listing packet')
    expect(agg.participants).toContain('carol@new.com')
    expect(agg.messageCount).toBe(2)
  })

  it('reply from a previously-unknown participant grows the participants array', () => {
    const msgs = [
      mk({ id: 'm1', threadId: 't3', from: RYAN, to: ['alice@example.com'], subject: 'Q', date: '2026-08-08T10:00:00Z' }),
      mk({ id: 'm2', threadId: 't3', from: 'dan@unknown.com', to: [RYAN], subject: 'Re: Q', date: '2026-08-08T11:00:00Z' }),
    ]
    const agg = aggregateThread(msgs, resolver)
    expect(agg.participants).toContain('dan@unknown.com')
  })

  it('contact resolution prefers the earliest-appearing match', () => {
    const msgs = [
      mk({ id: 'm1', threadId: 't4', from: RYAN, to: ['alice@example.com', 'bob@example.com'], date: '2026-08-08T10:00:00Z' }),
    ]
    // alice appears before bob in candidate order → cA wins, not cB.
    expect(aggregateThread(msgs, resolver).contactId).toBe('cA')
  })

  it('no matching contact → null contactId/leadId (thread stays unlinked)', () => {
    const msgs = [
      mk({ id: 'm1', threadId: 't5', from: RYAN, to: ['nobody@nowhere.com'], date: '2026-08-08T10:00:00Z' }),
    ]
    const agg = aggregateThread(msgs, noMatch)
    expect(agg.contactId).toBeNull()
    expect(agg.leadId).toBeNull()
  })

  it('is deterministic regardless of input order (idempotent upsert basis)', () => {
    const base = [
      mk({ id: 'm1', from: RYAN, to: ['alice@example.com'], subject: 'Coming soon', date: '2026-08-08T10:00:00Z' }),
      mk({ id: 'm2', from: 'alice@example.com', to: [RYAN], subject: 'Re: Coming soon', date: '2026-08-08T11:00:00Z' }),
      mk({ id: 'm3', from: RYAN, to: ['alice@example.com'], subject: 'Re: Coming soon', date: '2026-08-08T12:00:00Z' }),
    ]
    const a = aggregateThread(base, resolver)
    const b = aggregateThread([base[2], base[0], base[1]], resolver)
    expect(JSON.stringify(b)).toBe(JSON.stringify(a))
  })

  it('throws when messages span multiple providerThreadIds', () => {
    const msgs = [
      mk({ id: 'm1', threadId: 'tA', from: RYAN, date: '2026-08-08T10:00:00Z' }),
      mk({ id: 'm2', threadId: 'tB', from: RYAN, date: '2026-08-08T11:00:00Z' }),
    ]
    expect(() => aggregateThread(msgs, resolver)).toThrow(/multiple providerThreadIds/)
  })

  it('throws on empty input', () => {
    expect(() => aggregateThread([], resolver)).toThrow(/no messages/)
  })
})

describe('directionFor', () => {
  it('mail from the connected account is outgoing; otherwise incoming (case-insensitive)', () => {
    const fromRyan = mk({ id: 'x', from: 'Ryan@Elliman.com', date: '2026-08-08T10:00:00Z' })
    const fromAlice = mk({ id: 'y', from: 'alice@example.com', date: '2026-08-08T10:00:00Z' })
    expect(directionFor(fromRyan, RYAN)).toBe('outgoing')
    expect(directionFor(fromAlice, RYAN)).toBe('incoming')
  })
})
