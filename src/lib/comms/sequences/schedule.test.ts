import { describe, it, expect } from 'vitest'
import { DateTime } from 'luxon'
import {
  nextStepDueAt,
  applyBlackoutDates,
  resolveDueAt,
  DEFAULT_TIMEZONE,
  type SequenceStepLike,
} from './schedule'

const ET = 'America/New_York'
const HOUR = 3600 * 1000

const steps: SequenceStepLike[] = [
  { id: 's1', ordinal: 1, delayHours: 0 },
  { id: 's2', ordinal: 2, delayHours: 48 },
]

const etLocal = (dt: DateTime) => dt.setZone(ET).toFormat('yyyy-MM-dd HH:mm')

describe('nextStepDueAt', () => {
  const enrolledAt = new Date('2026-08-07T19:00:00Z')

  it('step 1 (delay 0) is due at enrolledAt', () => {
    expect(nextStepDueAt(enrolledAt, steps, 's1').toMillis()).toBe(
      enrolledAt.getTime(),
    )
  })

  it('step 2 is due at enrolledAt + inclusive sum of delays (0 + 48h)', () => {
    // Brief case: step1 delay 0h, step2 delay 48h → step 2 fires ~48h after step 1.
    expect(nextStepDueAt(enrolledAt, steps, 's2').toMillis()).toBe(
      enrolledAt.getTime() + 48 * HOUR,
    )
  })

  it('is order-independent (sorts by ordinal)', () => {
    const reversed = [...steps].reverse()
    expect(nextStepDueAt(enrolledAt, reversed, 's2').toMillis()).toBe(
      enrolledAt.getTime() + 48 * HOUR,
    )
  })

  it('returns a UTC DateTime', () => {
    expect(nextStepDueAt(enrolledAt, steps, 's1').zoneName).toBe('UTC')
  })

  it('throws on unknown currentStepId', () => {
    expect(() => nextStepDueAt(enrolledAt, steps, 'nope')).toThrow(/not found/)
  })
})

describe('applyBlackoutDates', () => {
  // Saturday 2026-08-08 3:00pm ET.
  const saturday3pm = DateTime.fromISO('2026-08-08T15:00', { zone: ET })

  it('no blackout dates → unchanged instant (as UTC)', () => {
    const out = applyBlackoutDates(saturday3pm, [], ET)
    expect(out.toMillis()).toBe(saturday3pm.toMillis())
    expect(out.zoneName).toBe('UTC')
  })

  it('due date not in blackout list → unchanged', () => {
    const out = applyBlackoutDates(saturday3pm, ['2026-12-25'], ET)
    expect(out.toMillis()).toBe(saturday3pm.toMillis())
  })

  it('single blackout day → defers to next day, same local hour (Sat→Sun 3pm ET)', () => {
    // Brief Gate-3 #4: due Saturday, blackout=[Saturday] → Sunday (next non-blackout).
    const out = applyBlackoutDates(saturday3pm, ['2026-08-08'], ET)
    expect(etLocal(out)).toBe('2026-08-09 15:00')
  })

  it('multi-day blackout → skips both, defers to Monday 3pm ET', () => {
    // Brief Gate-3 #4: blackout=[Sat, Sun] → Monday.
    const out = applyBlackoutDates(saturday3pm, ['2026-08-08', '2026-08-09'], ET)
    expect(etLocal(out)).toBe('2026-08-10 15:00')
  })

  it('DST-aware day advance preserves local wall time across the fall-back', () => {
    // 2026-10-31 01:30 ET, blackout that Saturday. Advancing one calendar day
    // lands on 2026-11-01 (a 25-hour day, DST fall-back). The local hour+minute
    // must stay 01:30 — not drift to 00:30/02:30, not double-fire.
    const preFallback = DateTime.fromISO('2026-10-31T01:30', { zone: ET })
    const out = applyBlackoutDates(preFallback, ['2026-10-31'], ET)
    expect(etLocal(out)).toBe('2026-11-01 01:30')
  })

  it('invalid timezone falls back to America/New_York', () => {
    const out = applyBlackoutDates(saturday3pm, ['2026-08-08'], 'Not/AZone')
    expect(etLocal(out)).toBe('2026-08-09 15:00')
  })

  it('bounds pathological all-blackout config instead of looping forever', () => {
    // Every day for a year+ is a blackout → should throw the safety bound.
    const many: string[] = []
    let d = DateTime.fromISO('2026-08-08', { zone: ET })
    for (let i = 0; i < 4000; i++) {
      many.push(d.toFormat('yyyy-MM-dd'))
      d = d.plus({ days: 1 })
    }
    expect(() => applyBlackoutDates(saturday3pm, many, ET)).toThrow(/exceeded/)
  })
})

describe('nextStepDueAt across DST (no double-fire)', () => {
  it('delay of 24h is exactly 24 absolute hours across the fall-back', () => {
    // 2026-11-01T05:00Z = 01:00 EDT, just before the 2am→1am fall-back.
    // A 24h delay must land exactly 24h later in absolute time, regardless of
    // the extra local hour that day (the classic DST double-fire bug).
    const enrolledAt = new Date('2026-11-01T05:00:00Z')
    const single: SequenceStepLike[] = [{ id: 'x', ordinal: 1, delayHours: 24 }]
    expect(nextStepDueAt(enrolledAt, single, 'x').toMillis()).toBe(
      enrolledAt.getTime() + 24 * HOUR,
    )
  })
})

describe('resolveDueAt (composition + null-timezone fallback)', () => {
  it('null contact timezone → uses America/New_York for blackout math', () => {
    // enrolledAt Fri 3pm ET (19:00Z, EDT=UTC-4) + 24h → Sat 3pm ET, which is a
    // blackout day → defer to Sun 3pm ET. Contact.timezone is null.
    const enrolledAt = new Date('2026-08-07T19:00:00Z')
    const single: SequenceStepLike[] = [{ id: 'a', ordinal: 1, delayHours: 24 }]
    const out = resolveDueAt({
      enrolledAt,
      steps: single,
      currentStepId: 'a',
      blackoutDates: ['2026-08-08'],
      contactTimezone: null,
    })
    expect(etLocal(out)).toBe('2026-08-09 15:00')
  })

  it('exposes the documented default timezone', () => {
    expect(DEFAULT_TIMEZONE).toBe('America/New_York')
  })
})
