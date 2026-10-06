import { describe, it, expect } from 'vitest'
import { addInternalDnc, internalDncHits, storedForms, type InternalDncDb } from '@/lib/compliance/dnc/internal'
import { runCallableNow, type CallableNowDeps } from '@/lib/compliance/scrub/callableNow'
import { toE164 } from '@/lib/shared/phone'

// Brief 41 (H13), from the audit's scratch/c2/t2_internal_dnc and t9 proofs: the
// known opt-out 917-331-2047 must block the lead whose phone the importer stored
// as +19173312047, however the opt-out was typed, and the other way round. A
// fake DB does exact string matching, like Postgres text '='.
type Row = { id: string; organizationId: string; phone: string; source: string; addedAt: Date }
function fakeDncDb(seed: Array<Pick<Row, 'phone'>> = []) {
  const rows: Row[] = seed.map((r, i) => ({ id: `seed_${i}`, organizationId: ORG, source: 'internal', addedAt: new Date(), ...r }))
  const db = {
    dncSuppression: {
      async findUnique({ where }: any) {
        const k = where.organizationId_phone_source
        return rows.find((r) => r.organizationId === k.organizationId && r.phone === k.phone && r.source === k.source) ?? null
      },
      async create({ data }: any) {
        const r = { id: `dnc_${rows.length}`, addedAt: new Date(), ...data }
        rows.push(r)
        return r
      },
      async findMany({ where }: any) {
        return rows
          .filter((r) => r.organizationId === where.organizationId && r.source === where.source && where.phone.in.includes(r.phone))
          .map((r) => ({ phone: r.phone }))
      },
    },
  }
  return { rows, db: db as unknown as InternalDncDb }
}

const ORG = 'org_ryan'
const MONDAY_NOON_ET = '2026-10-05T16:00:00Z'

// Every other gate is green, so the internal-DNC check is the only thing that
// can stop the call.
function deps(db: InternalDncDb, contactPhone: string): CallableNowDeps {
  return {
    orgId: ORG,
    correlationId: 'b41-h13',
    now: new Date(MONDAY_NOON_ET),
    loadContactPhones: async (ids) => new Map(ids.filter((i) => i === 'cp1').map((i) => [i, { phone: contactPhone, timezone: 'America/New_York', addressState: 'NY' }])),
    internalDncHits: (o, ps) => internalDncHits(o, ps, db),
    isPolicyConfirmed: async () => ({
      confirmed: true,
      config: { timezone: 'America/New_York', earliestHour: 9, latestHour: 20, allowedDaysOfWeek: [1, 2, 3, 4, 5], policyConfirmedBy: 'user:ryan|counsel:x|date:2026-10-05', policyConfirmedAt: new Date() },
    }),
    checkHoliday: async () => ({ blocked: false }),
    holidayFreshDays: async () => 1,
    checkDnc: async (_o, ps) => new Map(ps.map((p) => [p, { status: 'clean' as const }])),
    checkLitigator: async (_o, ps) => new Map(ps.map((p) => [p, { status: 'clean' as const }])),
    persist: async () => {},
  } as CallableNowDeps
}
const callable = async (db: InternalDncDb, contactPhone: string) =>
  (await runCallableNow({ contactPhoneIds: ['cp1'], atInstant: MONDAY_NOON_ET }, deps(db, contactPhone))).results[0]

describe('the internal opt-out list matches a number however it was typed (Brief 41, H13)', () => {
  for (const typed of ['+19173312047', '917-331-2047', '(917) 331-2047', '9173312047', '1-917-331-2047', '917.331.2047']) {
    it(`an opt-out entered as "${typed}" is stored as +19173312047 and blocks the lead`, async () => {
      const { db, rows } = fakeDncDb()
      const added = await addInternalDnc(ORG, { phone: typed, reason: 'wants off the list' }, db)
      expect(added).toMatchObject({ phone: '+19173312047', added: true })
      expect(rows.map((r) => r.phone)).toEqual(['+19173312047'])
      const r = await callable(db, '+19173312047')
      expect(r.callable).toBe(false)
      expect(r.reasons).toEqual(['internal_dnc'])
    })
  }

  it('a STOP stored as +19173312047 blocks a contact phone saved as "(917) 331-2047" (before the backfill)', async () => {
    const { db } = fakeDncDb()
    await addInternalDnc(ORG, { phone: '+19173312047', reason: 'sms_stop_received', addedBy: 'sms-inbound-handler' }, db)
    expect((await callable(db, '(917) 331-2047')).callable).toBe(false)
  })

  for (const legacy of ['9173312047', '19173312047']) {
    it(`an opt-out stored before Brief 41 as "${legacy}" still blocks the lead`, async () => {
      const { db } = fakeDncDb([{ phone: legacy }])
      expect((await callable(db, '+19173312047')).callable).toBe(false)
    })
  }

  it('re-adding the same number in another format is idempotent (added:false, one row)', async () => {
    const { db, rows } = fakeDncDb()
    await addInternalDnc(ORG, { phone: '+19173312047' }, db)
    const second = await addInternalDnc(ORG, { phone: '917-331-2047' }, db)
    expect(second.added).toBe(false)
    expect(rows).toHaveLength(1)
  })

  it('another number is still callable', async () => {
    const { db } = fakeDncDb()
    await addInternalDnc(ORG, { phone: '917-331-2047' }, db)
    expect((await callable(db, '+19173312048')).callable).toBe(true)
  })
})

describe('the suppression lookup key (GET /api/compliance/dnc/suppressions?phone=…)', () => {
  const key = (url: string) => toE164(new URL(url).searchParams.get('phone'))
  it('finds +19173312047 whether queried encoded, unencoded ("+" arrives as a space) or typed', () => {
    expect(key('https://crm.example/api/compliance/dnc/suppressions?phone=%2B19173312047')).toBe('+19173312047')
    expect(key('https://crm.example/api/compliance/dnc/suppressions?phone=+19173312047')).toBe('+19173312047')
    expect(key('https://crm.example/api/compliance/dnc/suppressions?phone=917-331-2047')).toBe('+19173312047')
    expect(key('https://crm.example/api/compliance/dnc/suppressions?phone=garbage')).toBeNull()
  })

  it('looks rows up in every stored form, so a row from before Brief 41 shows too', () => {
    expect(storedForms('+19173312047').sort()).toEqual(['+19173312047', '19173312047', '9173312047'])
    expect(storedForms('(917) 331-2047').sort()).toEqual(['+19173312047', '19173312047', '9173312047'])
    expect(storedForms('+442071838750')).toEqual(['+442071838750'])
  })
})
