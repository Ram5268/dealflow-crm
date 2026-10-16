import { describe, it, expect, vi } from 'vitest'

// The sweep is driven through an injected database; the app's Prisma client
// must never be used here.
vi.mock('@/lib/prisma', () => ({ prisma: {} }))

import { applyStopSweep, describeStopSweep, planStopSweep, type InboundSmsRow, type StopSweepDb } from './stop-sweep'

// Brief 41.1 (F5): the sweep for saved STOP texts whose opt-out was never
// recorded (a failed write answers 500, and Twilio doesn't redeliver by
// default). An in-memory fake of the two tables it touches.
function fakeDb(messages: InboundSmsRow[], optOuts: Array<{ organizationId: string; phone: string; source?: string }>) {
  const dnc = optOuts.map((r, i) => ({ id: `d${i}`, source: 'internal', addedAt: new Date(0), reason: null as string | null, addedBy: null as string | null, ...r }))
  const db = {
    message: {
      findMany: vi.fn(async ({ where, take }: any) =>
        messages
          .filter((m) => where.channel === 'sms' && where.direction === 'incoming' && (!where.id || m.id > where.id.gt))
          .sort((a, b) => (a.id < b.id ? -1 : 1))
          .slice(0, take),
      ),
    },
    dncSuppression: {
      findMany: vi.fn(async ({ where }: any) =>
        dnc.filter((r) => r.organizationId === where.organizationId && r.source === where.source && where.phone.in.includes(r.phone)),
      ),
      findUnique: vi.fn(async ({ where }: any) => {
        const k = where.organizationId_phone_source
        return dnc.find((r) => r.organizationId === k.organizationId && r.phone === k.phone && r.source === k.source) ?? null
      }),
      create: vi.fn(async ({ data }: any) => {
        const row = { id: `d${dnc.length}`, addedAt: new Date(1), ...data }
        dnc.push(row)
        return row
      }),
    },
  }
  return { db: db as unknown as StopSweepDb & typeof db, dnc }
}

const text = (id: string, body: string, from = '+19173312047', org = 'org_1', at = 0): InboundSmsRow => ({
  id, organizationId: org, smsRemotePhone: from, fromAddress: from, bodyText: body, dateCreated: new Date(at),
})

describe('lost-STOP sweep', () => {
  it('finds nothing when there are no texts (SMS is off today)', async () => {
    const { db } = fakeDb([], [])
    const plan = await planStopSweep(db)
    expect(describeStopSweep(plan)).toEqual({
      inboundTexts: 0, optOutTexts: 0, optOutNumbers: 0, alreadyOnList: 0, missingOptOuts: 0, missing: [], unreadableSender: [],
    })
  })

  it('dry run: lists the STOP texts with no opt-out, one per number, by message id only', async () => {
    const { db, dnc } = fakeDb(
      [
        text('m1', 'is it still available?'),
        text('m2', 'STOP', '+19173312047', 'org_1', 20),
        text('m3', 'stop texting me', '+19173312047', 'org_1', 10), // same number, earlier: the one reported (with m2's keyword reason)
        text('m4', 'Opt-Out', '(718) 555-0102'), // stored as typed: still read as a number
        text('m5', 'UNSUBSCRIBE', '+12125550199'), // already on the list in an old format
        text('m6', 'stop', 'not-a-phone'),
        text('m7', 'STOP', '+19173312047', 'org_2'), // another org: its own opt-out
      ],
      [{ organizationId: 'org_1', phone: '2125550199' }],
    )
    const out = describeStopSweep(await planStopSweep(db))
    expect(out).toEqual({
      inboundTexts: 7,
      optOutTexts: 6,
      optOutNumbers: 4,
      alreadyOnList: 1,
      missingOptOuts: 3,
      missing: [
        { messageId: 'm3', match: 'keyword', phrase: 'stop' },
        { messageId: 'm4', match: 'keyword', phrase: 'opt out' },
        { messageId: 'm7', match: 'keyword', phrase: 'stop' },
      ],
      unreadableSender: ['m6'],
    })
    // The output never carries a phone number or a message body.
    expect(JSON.stringify(out)).not.toMatch(/\d{7}|texting/)
    // A dry run writes nothing.
    expect(db.dncSuppression.create).not.toHaveBeenCalled()
    expect(dnc).toHaveLength(1)
  })

  it('apply: adds each missing opt-out in canonical form, with the reason for its kind of match', async () => {
    const { db, dnc } = fakeDb([text('m1', 'please stop', '917-331-2047'), text('m2', 'STOP', '+12125550100')], [])
    const plan = await planStopSweep(db)
    expect(await applyStopSweep(db, plan)).toEqual({ added: 2, alreadyThere: 0 })
    expect(dnc.map((r) => [r.organizationId, r.phone, r.source, r.reason, r.addedBy])).toEqual([
      ['org_1', '+19173312047', 'internal', 'sms_stop_phrase', 'brief41-1-stop-sweep'],
      ['org_1', '+12125550100', 'internal', 'sms_stop_received', 'brief41-1-stop-sweep'],
    ])
    // Re-running finds nothing left.
    expect((await planStopSweep(db)).missing).toEqual([])
  })

  it('a number that also sent a plain keyword gets the keyword reason, reported by its earliest text', async () => {
    const { db, dnc } = fakeDb([text('m1', 'can you stop by?', '+19173312047', 'org_1', 5), text('m2', 'STOP', '+19173312047', 'org_1', 9)], [])
    const plan = await planStopSweep(db)
    expect(describeStopSweep(plan).missing).toEqual([{ messageId: 'm1', match: 'keyword', phrase: 'stop' }])
    await applyStopSweep(db, plan)
    expect(dnc.map((r) => r.reason)).toEqual(['sms_stop_received'])
  })

  it('reads every page of texts', async () => {
    const many = Array.from({ length: 2500 }, (_, i) => text(`m${String(i).padStart(5, '0')}`, i === 2400 ? 'STOP' : 'hi', `+1212555${String(1000 + (i % 9000)).slice(-4)}`))
    const { db } = fakeDb(many, [])
    const plan = await planStopSweep(db)
    expect(plan.inboundTexts).toBe(2500)
    expect(plan.missing.map((m) => m.messageId)).toEqual(['m02400'])
    expect(db.message.findMany).toHaveBeenCalledTimes(3)
  })
})
