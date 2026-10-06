import { describe, it, expect } from 'vitest'
import { normalizeE164, addInternalDnc, internalDncHits, InvalidPhoneError } from '@/lib/compliance/dnc/internal'

function makeStoreDb() {
  const store = new Map<string, { id: string; phone: string; addedAt: Date }>()
  return {
    store,
    db: {
      dncSuppression: {
        findUnique: async ({ where }: any) => store.get(where.organizationId_phone_source.phone) ?? null,
        create: async ({ data }: any) => {
          if (store.has(data.phone)) throw new Error('unique violation')
          const row = { id: `id_${data.phone}`, phone: data.phone, addedAt: new Date('2026-09-01T00:00:00Z') }
          store.set(data.phone, row)
          return row
        },
        findMany: async ({ where }: any) =>
          [...store.values()].filter((r) => where.phone.in.includes(r.phone)).map((r) => ({ phone: r.phone })),
      },
    },
  }
}

describe('normalizeE164', () => {
  it('canonical E.164 however the number is typed (Brief 41, H13)', () => {
    expect(normalizeE164('+1 (212) 555-0101')).toBe('+12125550101')
    expect(normalizeE164(' +12125550101 ')).toBe('+12125550101')
    for (const typed of ['917-331-2047', '(917) 331-2047', '9173312047', '1-917-331-2047', '917.331.2047', '+1 917 331 2047']) {
      expect(normalizeE164(typed)).toBe('+19173312047')
    }
  })

  it('a value that is not a phone number keeps the old punctuation-stripped form', () => {
    expect(normalizeE164('not a phone')).toBe('notaphone')
  })
})

describe('addInternalDnc', () => {
  it('added:true on first insert, added:false (same id) on re-add', async () => {
    const { db } = makeStoreDb()
    const first = await addInternalDnc('o', { phone: '+1 (212) 555-0101', reason: 'sms_stop' }, db as any)
    expect(first).toMatchObject({ phone: '+12125550101', source: 'internal', added: true })

    const second = await addInternalDnc('o', { phone: '+12125550101' }, db as any)
    expect(second.added).toBe(false)
    expect(second.id).toBe(first.id)
  })

  it('handles a create race: create throws, re-read returns existing => added:false', async () => {
    let findCalls = 0
    const existing = { id: 'id_race', phone: '+15555550101', addedAt: new Date('2026-09-01T00:00:00Z') }
    const db = {
      dncSuppression: {
        findUnique: async () => {
          findCalls++
          return findCalls === 1 ? null : existing // absent on first check, present after race
        },
        create: async () => {
          throw new Error('unique violation')
        },
      },
    }
    const r = await addInternalDnc('o', { phone: '+15555550101' }, db as any)
    expect(r.added).toBe(false)
    expect(r.id).toBe('id_race')
  })

  it('refuses a value that is not a phone number (the route answers 400)', async () => {
    const { db, store } = makeStoreDb()
    await expect(addInternalDnc('o', { phone: 'call me maybe' }, db as any)).rejects.toBeInstanceOf(InvalidPhoneError)
    await expect(addInternalDnc('o', { phone: '12345' }, db as any)).rejects.toBeInstanceOf(InvalidPhoneError)
    expect(store.size).toBe(0)
  })

  it('re-throws when create fails and no row can be found', async () => {
    const db = {
      dncSuppression: {
        findUnique: async () => null,
        create: async () => {
          throw new Error('db down')
        },
      },
    }
    await expect(addInternalDnc('o', { phone: '+15555550101' }, db as any)).rejects.toThrow('db down')
  })
})

describe('internalDncHits (batch)', () => {
  it('returns the set of phones present on the internal list', async () => {
    const { db } = makeStoreDb()
    await addInternalDnc('o', { phone: '+12125550101' }, db as any)
    const hits = await internalDncHits('o', ['+12125550101', '+15550000000'], db as any)
    expect(hits.has('+12125550101')).toBe(true)
    expect(hits.has('+15550000000')).toBe(false)
  })

  it('short-circuits to empty set for no phones', async () => {
    const { db } = makeStoreDb()
    expect((await internalDncHits('o', [], db as any)).size).toBe(0)
  })
})
