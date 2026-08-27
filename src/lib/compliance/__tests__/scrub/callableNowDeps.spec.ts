import { describe, it, expect, beforeEach } from 'vitest'
import { makeCallableNowDeps } from '@/lib/compliance/scrub/callableNowDeps'
import { runCallableNow } from '@/lib/compliance/scrub/callableNow'
import { resetAllCaches } from '@/lib/compliance/caches'

const CID = '11111111-1111-4111-8111-111111111111'
const now = new Date('2026-01-05T17:00:00Z') // Monday noon EST
const CONFIRMED = {
  timezone: 'America/New_York',
  earliestHour: 9,
  latestHour: 20,
  allowedDaysOfWeek: [1, 2, 3, 4, 5],
  policyConfirmedBy: 'user:ryan|counsel:jdoe|date:2026-09-01',
  policyConfirmedAt: now,
}

function fakePrisma(rows: any[]) {
  const notified: unknown[] = []
  const scrubLogged: any[] = []
  return {
    notified,
    scrubLogged,
    client: {
      contactPhone: { findMany: async () => rows },
      dncSuppression: { findMany: async () => [] },
      callingWindowConfig: { findUnique: async () => CONFIRMED },
      // Fresh createdAt (real clock) so holidayTableFreshDays sees a non-stale table.
      holidaySuppressionDate: { findMany: async () => [], findFirst: async () => ({ createdAt: new Date() }) },
      $transaction: async (fn: any) =>
        fn({
          scrubLog: { createMany: async (a: any) => (scrubLogged.push(...a.data), { count: a.data.length }) },
          $executeRaw: async (_p: TemplateStringsArray, ...v: unknown[]) => (notified.push(v[0]), 1),
        }),
    },
  }
}

beforeEach(() => resetAllCaches())

describe('makeCallableNowDeps', () => {
  it('loadContactPhones maps rows + derives address state per §1a', async () => {
    const p = fakePrisma([
      {
        id: 'cp1',
        phone: '+12125550001',
        contact: { timezone: 'America/New_York', lead: { addresses: [{ state: 'NY' }], primaryAddressFull: '123 Main' } },
      },
      { id: 'cp2', phone: '+12125550002', contact: { timezone: 'America/Chicago', lead: { addresses: [{ state: 'IL' }], primaryAddressFull: null } } },
      { id: 'cp3', phone: '+12125550003', contact: { timezone: 'America/New_York', lead: { addresses: [], primaryAddressFull: '1 X' } } },
    ])
    const deps = makeCallableNowDeps({ orgId: 'o', correlationId: CID, now, prisma: p.client })
    const map = await deps.loadContactPhones(['cp1', 'cp2', 'cp3'])
    expect(map.get('cp1')).toEqual({ phone: '+12125550001', timezone: 'America/New_York', addressState: 'NY' })
    // primaryAddressFull null => address not trusted => null
    expect(map.get('cp2')!.addressState).toBeNull()
    // empty addresses array => null
    expect(map.get('cp3')!.addressState).toBeNull()
  })

  it('loadContactPhones handles null lead, non-string state, and missing contact', async () => {
    const p = fakePrisma([
      { id: 'a', phone: '+1', contact: { timezone: 'America/New_York', lead: null } }, // null lead
      { id: 'b', phone: '+2', contact: { timezone: null, lead: { addresses: [{ state: 123 }], primaryAddressFull: 'x' } } }, // non-string state
      { id: 'c', phone: '+3', contact: null }, // missing contact
    ])
    const deps = makeCallableNowDeps({ orgId: 'o', correlationId: CID, now, prisma: p.client })
    const map = await deps.loadContactPhones(['a', 'b', 'c'])
    expect(map.get('a')!.addressState).toBeNull()
    expect(map.get('b')!.addressState).toBeNull()
    expect(map.get('c')).toEqual({ phone: '+3', timezone: null, addressState: null })
  })

  it('persist writes ScrubLogs and emits scrub.completed inside one transaction', async () => {
    const p = fakePrisma([])
    const deps = makeCallableNowDeps({ orgId: 'o', correlationId: CID, now, prisma: p.client })
    await deps.persist(
      'o',
      [{ phone: '+1', operation: 'check-window', result: 'clean' }],
      { phoneCount: 1, blockedCount: 0, checkedAt: now.toISOString(), correlationId: CID }
    )
    expect(p.scrubLogged).toHaveLength(1)
    expect(p.notified).toHaveLength(1)
    const payload = JSON.parse(p.notified[0] as string)
    expect(payload).toMatchObject({ phoneCount: 1, blockedCount: 0, correlationId: CID })
  })

  it('end-to-end through the real pipeline with a fake Prisma -> callable:true', async () => {
    const p = fakePrisma([
      {
        id: 'cp1',
        phone: '+12125550001',
        contact: { timezone: 'America/New_York', lead: { addresses: [{ state: 'NY' }], primaryAddressFull: '123 Main' } },
      },
    ])
    const deps = makeCallableNowDeps({ orgId: 'o', correlationId: CID, now, prisma: p.client })
    const { results } = await runCallableNow({ contactPhoneIds: ['cp1'] }, deps)
    expect(results[0]).toMatchObject({ contactPhoneId: 'cp1', phone: '+12125550001', callable: true })
    expect(p.notified).toHaveLength(1) // event emitted
  })
})
