import { describe, it, expect } from 'vitest'
import { addInternalDnc, internalDncHits, storedForms, type InternalDncDb } from '@/lib/compliance/dnc/internal'
import { runCallableNow, type CallableNowDeps } from '@/lib/compliance/scrub/callableNow'
import { toE164 } from '@/lib/shared/phone'

// Brief 41 (H13), from the audit's scratch/c2/t2_internal_dnc and t9 proofs: the
// known opt-out 917-555-0147 must block the lead whose phone the importer stored
// as +19175550147, however the opt-out was typed, and the other way round. A
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
  for (const typed of ['+19175550147', '917-555-0147', '(917) 555-0147', '9175550147', '1-917-555-0147', '917.555.0147']) {
    it(`an opt-out entered as "${typed}" is stored as +19175550147 and blocks the lead`, async () => {
      const { db, rows } = fakeDncDb()
      const added = await addInternalDnc(ORG, { phone: typed, reason: 'wants off the list' }, db)
      expect(added).toMatchObject({ phone: '+19175550147', added: true })
      expect(rows.map((r) => r.phone)).toEqual(['+19175550147'])
      const r = await callable(db, '+19175550147')
      expect(r.callable).toBe(false)
      expect(r.reasons).toEqual(['internal_dnc'])
    })
  }

  it('a STOP stored as +19175550147 blocks a contact phone saved as "(917) 555-0147" (before the backfill)', async () => {
    const { db } = fakeDncDb()
    await addInternalDnc(ORG, { phone: '+19175550147', reason: 'sms_stop_received', addedBy: 'sms-inbound-handler' }, db)
    expect((await callable(db, '(917) 555-0147')).callable).toBe(false)
  })

  for (const legacy of ['9175550147', '19175550147']) {
    it(`an opt-out stored before Brief 41 as "${legacy}" still blocks the lead`, async () => {
      const { db } = fakeDncDb([{ phone: legacy }])
      expect((await callable(db, '+19175550147')).callable).toBe(false)
    })
  }

  // Brief 50 PR 17 (the planner's review, Brief 50 Revision 2, 2026-10-23):
  // before PR 13 the parser read an opt-out typed "+917 555 0147" as an Indian
  // number and stored it as "+9175550147" ("+" and the 10 digits), which the
  // lead's +19175550147 never matched.
  it('an opt-out stored before Brief 50 PR 13 as "+9175550147" blocks the lead stored as +19175550147', async () => {
    const { db } = fakeDncDb([{ phone: '+9175550147' }])
    expect([...(await internalDncHits(ORG, ['+19175550147'], db))]).toEqual(['+19175550147'])
    expect([...(await internalDncHits(ORG, ['(917) 555-0147'], db))]).toEqual(['+19175550147'])
    const r = await callable(db, '+19175550147')
    expect(r.callable).toBe(false)
    expect(r.reasons).toEqual(['internal_dnc'])
  })

  it('…and a different number is still callable next to it', async () => {
    const { db } = fakeDncDb([{ phone: '+9175550147' }])
    expect((await callable(db, '+19175550148')).callable).toBe(true)
  })

  // Matching may only get broader [the planner's review, Brief 50 Revision 2]:
  // every form the matcher looked a number up in before PR 17 is still looked
  // up, so a call check never stops blocking anything it blocks today.
  it('storedForms still includes every form it did before Brief 50 PR 17', () => {
    const before = (raw: string) => {
      const canonical = toE164(raw) ?? raw.trim().replace(/[\s()\-.]/g, '')
      const forms = new Set([canonical, raw.trim().replace(/[\s()\-.]/g, '')])
      if (/^\+1\d{10}$/.test(canonical)) {
        forms.add(canonical.slice(1))
        forms.add(canonical.slice(2))
      }
      return [...forms].filter(Boolean)
    }
    const inputs = [
      '+19175550147', '917-555-0147', '(917) 555-0147', '9175550147', '19175550147', '+9175550147', '+917 555 0147',
      '+1 212 555 0123', '+442079460750', '+91 212 555 0123', '+64 (0)6 555 0123', '9175550147x5', 'not a phone', ' ',
    ]
    for (const raw of inputs) expect(storedForms(raw), raw).toEqual(expect.arrayContaining(before(raw)))
  })

  it('a batch with the same number typed two ways still matches an old row stored as typed', async () => {
    const { db } = fakeDncDb([{ phone: '9175550147x5' }])
    const hits = await internalDncHits(ORG, ['917-555-0147 x5', '+19175550147'], db)
    expect(hits.has('+19175550147')).toBe(true)
  })

  it('re-adding the same number in another format is idempotent (added:false, one row)', async () => {
    const { db, rows } = fakeDncDb()
    await addInternalDnc(ORG, { phone: '+19175550147' }, db)
    const second = await addInternalDnc(ORG, { phone: '917-555-0147' }, db)
    expect(second.added).toBe(false)
    expect(rows).toHaveLength(1)
  })

  it('another number is still callable', async () => {
    const { db } = fakeDncDb()
    await addInternalDnc(ORG, { phone: '917-555-0147' }, db)
    expect((await callable(db, '+19175550148')).callable).toBe(true)
  })
})

describe('the suppression lookup key (GET /api/compliance/dnc/suppressions?phone=…)', () => {
  const key = (url: string) => toE164(new URL(url).searchParams.get('phone'))
  it('finds +19175550147 whether queried encoded, unencoded ("+" arrives as a space) or typed', () => {
    expect(key('https://crm.example/api/compliance/dnc/suppressions?phone=%2B19175550147')).toBe('+19175550147')
    expect(key('https://crm.example/api/compliance/dnc/suppressions?phone=+19175550147')).toBe('+19175550147')
    expect(key('https://crm.example/api/compliance/dnc/suppressions?phone=917-555-0147')).toBe('+19175550147')
    expect(key('https://crm.example/api/compliance/dnc/suppressions?phone=garbage')).toBeNull()
  })

  it('looks rows up in every stored form, so a row from before Brief 41 shows too', () => {
    // Brief 50 PR 17: plus "+9175550147", the form PR 13 fixed (until DS-1 rewrites stored rows).
    expect(storedForms('+19175550147').sort()).toEqual(['+19175550147', '+9175550147', '19175550147', '9175550147'])
    expect(storedForms('(917) 555-0147').sort()).toEqual(['+19175550147', '+9175550147', '19175550147', '9175550147'])
    expect(storedForms('+442079460750')).toEqual(['+442079460750'])
  })
})
