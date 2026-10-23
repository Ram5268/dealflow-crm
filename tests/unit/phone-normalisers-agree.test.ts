import { describe, it, expect, vi } from 'vitest'
import { toE164, canonicalPhones } from '@/lib/shared/phone'
import { addInternalDnc, internalDncHits, normalizeE164, InvalidPhoneError, type InternalDncDb } from '@/lib/compliance/dnc/internal'
import { planPhoneBackfill } from '@/lib/compliance/dnc/phoneBackfill'
import { runPhoneBackfill, type BackfillDb } from '@/lib/compliance/dnc/phoneBackfillRun'
import { runCallableNow, type CallableNowDeps } from '@/lib/compliance/scrub/callableNow'
import { normalizePhoneE164 } from '@/lib/core-data/importer/dedup'
import { submitOptOut } from '@/lib/settings/doNotContact'

// Brief 50 PR 13 (open item 6.9): every place that turns a typed phone into the
// stored or matched form must give the same canonical string (+1 and 10 digits
// for a US number), or an opt-out and a lead's phone can miss each other
// [engineering precaution]. The places:
//   - the shared parser (src/lib/shared/phone.ts toE164), which the others call;
//   - the contacts API (canonicalPhones);
//   - an opt-out added by the API, a STOP text or Settings → Do not contact
//     (addInternalDnc; Settings posts the typed value to that route unchanged);
//   - the opt-out lookup key (normalizeE164), used by the compliance engine's
//     callable-now check, which the call Queue (smart-view/queue-service.ts)
//     runs on the lead's stored phone without changing it;
//   - the importer (importer/dedup.ts normalizePhoneE164: also the duplicate key);
//   - data step DS-1 (scripts/brief41-canonical-phones.ts → planPhoneBackfill).
// Phones only from the fictional 555-0100…0199 range, or a published fictional
// foreign range.

type Normaliser = (typed: string) => Promise<string | null>

function fakeDncDb() {
  const rows: Array<{ id: string; organizationId: string; phone: string; source: string; addedAt: Date }> = []
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

const ORG = 'org_test'

// What each place stores or matches a typed value as (null = "not a phone number").
const NORMALISERS: Record<string, Normaliser> = {
  'shared parser (toE164)': async (t) => toE164(t),
  'contacts API (canonicalPhones)': async (t) => {
    const r = canonicalPhones([{ phone: t }])
    return r.ok ? r.phones[0].phone : null
  },
  'opt-out as stored (addInternalDnc)': async (t) => {
    try {
      return (await addInternalDnc(ORG, { phone: t }, fakeDncDb().db)).phone
    } catch (err) {
      if (err instanceof InvalidPhoneError) return null
      throw err
    }
  },
  'Settings → Do not contact (posts to addInternalDnc)': async (t) => {
    let posted: string | undefined
    const fetchImpl = vi.fn(async (_url: unknown, init?: RequestInit) => {
      posted = JSON.parse(String(init?.body)).phone
      return new Response(JSON.stringify({ id: 'x', phone: 'stored', source: 'internal', added: true }), { status: 201 })
    })
    await submitOptOut({ phone: t }, fetchImpl as unknown as typeof fetch)
    try {
      return (await addInternalDnc(ORG, { phone: posted! }, fakeDncDb().db)).phone
    } catch (err) {
      if (err instanceof InvalidPhoneError) return null
      throw err
    }
  },
  'opt-out lookup key (normalizeE164)': async (t) => (toE164(t) === null ? null : normalizeE164(t)),
  'importer + duplicate key (normalizePhoneE164)': async (t) => normalizePhoneE164(t),
  'DS-1 contact phone (planPhoneBackfill)': async (t) => {
    const plan = planPhoneBackfill([], [{ id: 'p1', contactId: 'c1', phone: t }])
    if (plan.contactPhones.unparseable.length) return null
    return plan.contactPhones.rewrite[0]?.phone ?? t
  },
  'DS-1 opt-out (planPhoneBackfill)': async (t) => {
    const plan = planPhoneBackfill([{ id: 'd1', organizationId: ORG, source: 'internal', phone: t }], [])
    if (plan.dnc.unparseable.length) return null
    return plan.dnc.rewrite[0]?.phone ?? t
  },
}

async function everyNormaliser(typed: string): Promise<Record<string, string | null>> {
  const out: Record<string, string | null> = {}
  for (const [name, fn] of Object.entries(NORMALISERS)) out[name] = await fn(typed)
  return out
}
const all = (value: string | null, except: Record<string, string | null> = {}) =>
  ({ ...Object.fromEntries(Object.keys(NORMALISERS).map((n) => [n, value])), ...except })

describe('every phone normaliser gives the same canonical string', () => {
  // Valid numbers: every place, the importer included, agrees exactly.
  const VALID: Array<[typed: string, canonical: string]> = [
    ['+9175550123', '+19175550123'],
    ['+917 555 0123', '+19175550123'],
    ['(+917) 555-0123', '+19175550123'],
    ['+917 555 0123 ext 5', '+19175550123'],
    ['+19175550123', '+19175550123'],
    ['+1 917 555 0123', '+19175550123'],
    ['917-555-0123', '+19175550123'],
    ['(917) 555-0123', '+19175550123'],
    ['1-917-555-0123', '+19175550123'],
    ['+2125550147', '+12125550147'],
    ['(212) 555-0147', '+12125550147'],
    ['+646 555 0123', '+16465550123'],
    ['+516 555 0123', '+15165550123'],
    ['+718 555 0199', '+17185550199'],
    ['+44 20 7946 0750', '+442079460750'],
    ['+91 212 555 0123', '+912125550123'],
    ['+61 2 5550 0123', '+61255500123'],
  ]
  for (const [typed, canonical] of VALID) {
    it(`"${typed}" → ${canonical} everywhere`, async () => {
      expect(await everyNormaliser(typed)).toEqual(all(canonical))
    })
  }

  // Possible but not valid numbers: the importer drops them (it never stores a
  // guess); every other place keeps the same canonical string.
  const POSSIBLE_ONLY: Array<[typed: string, canonical: string]> = [
    ['+1 555 555 0101', '+15555550101'],
    ['+555 555 0123', '+5555550123'],
  ]
  for (const [typed, canonical] of POSSIBLE_ONLY) {
    it(`"${typed}" → ${canonical} everywhere except the importer, which drops it`, async () => {
      expect(await everyNormaliser(typed)).toEqual(all(canonical, { 'importer + duplicate key (normalizePhoneE164)': null }))
    })
  }

  it('something that is not a phone number is "not a phone" everywhere', async () => {
    for (const bad of ['call me', '12345', '+0125550123']) expect(await everyNormaliser(bad), bad).toEqual(all(null))
  })
})

// The call Queue (queue-service.ts) sends a lead's stored phone, unchanged, to
// the compliance engine's callable-now check, which looks it up on the
// opt-out list. Every other gate is green here, so the opt-out is the only
// thing that can stop the call.
const MONDAY_NOON_ET = '2026-10-05T16:00:00Z'
function deps(db: InternalDncDb, storedLeadPhone: string): CallableNowDeps {
  return {
    orgId: ORG,
    correlationId: 'b50-pr13',
    now: new Date(MONDAY_NOON_ET),
    loadContactPhones: async (ids) => new Map(ids.map((i) => [i, { phone: storedLeadPhone, timezone: 'America/New_York', addressState: 'NY' }])),
    internalDncHits: (o, ps) => internalDncHits(o, ps, db),
    isPolicyConfirmed: async () => ({
      confirmed: true,
      config: { timezone: 'America/New_York', earliestHour: 9, latestHour: 20, allowedDaysOfWeek: [1, 2, 3, 4, 5], policyConfirmedBy: 'test', policyConfirmedAt: new Date() },
    }),
    checkHoliday: async () => ({ blocked: false }),
    holidayFreshDays: async () => 1,
    checkDnc: async (_o, ps) => new Map(ps.map((p) => [p, { status: 'clean' as const }])),
    checkLitigator: async (_o, ps) => new Map(ps.map((p) => [p, { status: 'clean' as const }])),
    persist: async () => {},
  } as CallableNowDeps
}
const callable = async (db: InternalDncDb, storedLeadPhone: string) =>
  (await runCallableNow({ contactPhoneIds: ['cp1'], atInstant: MONDAY_NOON_ET }, deps(db, storedLeadPhone))).results[0]

describe('an opt-out blocks the lead however either side was typed', () => {
  const FORMS = ['+9175550123', '+917 555 0123', '(+917) 555-0123', '917-555-0123', '(917) 555-0123', '+1 917 555 0123', '19175550123']
  for (const optOut of FORMS) {
    it(`an opt-out typed "${optOut}" blocks the lead, whichever way its phone was typed`, async () => {
      const { db, rows } = fakeDncDb()
      await addInternalDnc(ORG, { phone: optOut }, db)
      expect(rows.map((r) => r.phone)).toEqual(['+19175550123'])
      for (const leadPhone of FORMS) {
        for (const stored of [toE164(leadPhone)!, leadPhone]) {
          // stored = as the contacts API stores it, and as typed (a phone saved before Brief 41)
          const r = await callable(db, stored)
          expect({ leadPhone, stored, callable: r.callable, reasons: r.reasons }).toEqual({ leadPhone, stored, callable: false, reasons: ['internal_dnc'] })
        }
      }
    })
  }

  it('a phone saved before this fix as "+9175550123" is blocked by an opt-out saved as +19175550123', async () => {
    const { db } = fakeDncDb()
    await addInternalDnc(ORG, { phone: '+19175550123' }, db)
    expect((await callable(db, '+9175550123')).callable).toBe(false)
  })

  it('an opt-out typed with a "0" after the first digits ("+64 (0)6 555 0123") blocks the lead stored as +16465550123', async () => {
    const { db, rows } = fakeDncDb()
    await addInternalDnc(ORG, { phone: '+64 (0)6 555 0123' }, db)
    expect(rows.map((r) => r.phone)).toEqual(['+16465550123'])
    expect((await callable(db, toE164('+646 555 0123')!)).callable).toBe(false)
  })

  it('the importer finds a "+917…" row a duplicate of the lead already stored as +19175550123', () => {
    expect(normalizePhoneE164('+917 555 0123')).toBe(normalizePhoneE164('(917) 555-0123'))
  })

  it('a different number is still callable, and +91 with a full Indian number is not the US one', async () => {
    const { db } = fakeDncDb()
    await addInternalDnc(ORG, { phone: '+917 555 0123' }, db)
    expect((await callable(db, '+19175550124')).callable).toBe(true)
    const india = fakeDncDb()
    await addInternalDnc(ORG, { phone: '+91 212 555 0123' }, india.db)
    expect((await callable(india.db, '+12125550123')).callable).toBe(true)
  })
})

// Data step DS-1 (scripts/brief41-canonical-phones.ts → phoneBackfillRun.ts →
// phoneBackfill.ts → toE164) runs after this merges. It now rewrites a phone
// stored in the old "+" + 10 digits reading.
describe('data step DS-1 picks the fix up', () => {
  it('plans a "+9175550123" contact phone and opt-out for rewrite to +19175550123', () => {
    const plan = planPhoneBackfill(
      [{ id: 'd1', organizationId: ORG, source: 'internal', phone: '+9175550123' }],
      [{ id: 'p1', contactId: 'c1', phone: '+9175550123' }, { id: 'p2', contactId: 'c2', phone: '+6465550123' }],
    )
    expect(plan.dnc.rewrite).toEqual([{ id: 'd1', phone: '+19175550123' }])
    expect(plan.contactPhones.rewrite).toEqual([{ id: 'p1', phone: '+19175550123' }, { id: 'p2', phone: '+16465550123' }])
  })

  it('a contact that already has +19175550123 keeps one copy (the old "+917…" row is left as it is)', () => {
    const plan = planPhoneBackfill([], [{ id: 'p1', contactId: 'c1', phone: '+19175550123' }, { id: 'p2', contactId: 'c1', phone: '+9175550123' }])
    expect(plan.contactPhones).toEqual({ rewrite: [], alreadyCovered: ['p2'], unparseable: [] })
  })

  it("the script's dry run counts them (counts only, no phone numbers printed)", async () => {
    const tables = {
      dnc: [{ id: 'd1', organizationId: ORG, source: 'internal', phone: '+19175550123' }],
      phones: [{ id: 'p1', contactId: 'c1', phone: '+9175550123' }, { id: 'p2', contactId: 'c2', phone: '+12125550147' }],
    }
    const db = {
      dncSuppression: { findMany: async () => tables.dnc, updateMany: vi.fn() },
      contactPhone: { findMany: async () => tables.phones, updateMany: vi.fn() },
    } as unknown as BackfillDb
    const lines: string[] = []
    await runPhoneBackfill({ db, args: [], log: (l) => lines.push(l), database: 'b50_test', repoRoot: '/nonexistent', defaultPreImageDir: '/nonexistent' })
    expect(JSON.parse(lines[0])).toMatchObject({ optOutsToRewrite: 0, contactPhonesToRewrite: 1, rowsToRewrite: 1 })
    expect(lines.join('\n')).not.toMatch(/555/)
    expect(db.contactPhone.updateMany).not.toHaveBeenCalled()
  })
})
