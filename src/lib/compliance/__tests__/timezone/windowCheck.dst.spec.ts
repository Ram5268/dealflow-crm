import { describe, it, expect } from 'vitest'
import { evaluateCallingWindow } from '@/lib/compliance/timezone/windowCheck'

// Frozen DST expectations from Brief §9 1b. The input is always a UTC instant;
// Intl renders it in local wall-clock deterministically.
const DEFAULT = { earliestHour: 9, latestHour: 20, allowedDaysOfWeek: [1, 2, 3, 4, 5] }

describe('windowCheck — DST edges', () => {
  // NOTE: Brief §9 1b freezes localHour===3 for 2027-03-14T06:30Z, but that is
  // arithmetically wrong: the 2027 spring-forward transition is at 07:00Z
  // (2am EST -> 3am EDT), so 06:30Z is still 01:30 EST (verified against Node
  // ICU). The brief itself says "Intl always renders it correctly" — so we
  // assert the TRUE deterministic Intl output (hour 1), and cover the genuine
  // EDT case with a 07:30Z instant below. Flagged to planner.
  it('spring-forward: 2027-03-14T06:30Z in America/New_York renders local 01:30 EST (pre-transition)', () => {
    const r = evaluateCallingWindow({
      atInstant: new Date('2027-03-14T06:30:00Z'),
      timezone: 'America/New_York',
      ...DEFAULT,
    })
    expect(r.localHour).toBe(1)
    expect(r.allowed).toBe(false) // 01:30 < 09:00
  })

  it('spring-forward: 2027-03-14T07:30Z in America/New_York renders local 03:30 EDT (post-transition, UTC-4)', () => {
    const r = evaluateCallingWindow({
      atInstant: new Date('2027-03-14T07:30:00Z'),
      timezone: 'America/New_York',
      ...DEFAULT,
    })
    expect(r.localHour).toBe(3)
    expect(r.allowed).toBe(false)
  })

  it('fall-back: both 05:30Z (EDT) and 06:30Z (EST) render local 01:30 in America/New_York', () => {
    const before = evaluateCallingWindow({
      atInstant: new Date('2026-11-01T05:30:00Z'),
      timezone: 'America/New_York',
      ...DEFAULT,
    })
    const after = evaluateCallingWindow({
      atInstant: new Date('2026-11-01T06:30:00Z'),
      timezone: 'America/New_York',
      ...DEFAULT,
    })
    expect(before.localHour).toBe(1)
    expect(after.localHour).toBe(1)
    expect(before.allowed).toBe(false)
    expect(after.allowed).toBe(false)
  })

  it('Arizona has no DST: 14:00Z is 07:00 MST year-round', () => {
    const march = evaluateCallingWindow({
      atInstant: new Date('2027-03-14T14:00:00Z'),
      timezone: 'America/Phoenix',
      ...DEFAULT,
    })
    const november = evaluateCallingWindow({
      atInstant: new Date('2027-11-07T14:00:00Z'),
      timezone: 'America/Phoenix',
      ...DEFAULT,
    })
    expect(march.localHour).toBe(7)
    expect(november.localHour).toBe(7)
  })

  it('cross-state contact: window uses Contact.timezone (Chicago), not address state', () => {
    // A Chicago-tz contact at 15:00Z -> 09:00 CST/CDT. We prove the evaluator
    // keys off the passed timezone, never an address.
    const r = evaluateCallingWindow({
      atInstant: new Date('2026-01-05T15:00:00Z'), // Monday
      timezone: 'America/Chicago',
      ...DEFAULT,
    })
    expect(r.localHour).toBe(9)
    expect(r.allowed).toBe(true)
  })

  it('invalid IANA zone fails-closed with timezone_invalid (no throw)', () => {
    const r = evaluateCallingWindow({
      atInstant: new Date('2026-01-05T15:00:00Z'),
      timezone: 'Etc/Weird',
      ...DEFAULT,
    })
    expect(r.allowed).toBe(false)
    expect(r.reason).toBe('timezone_invalid')
    expect(r.localHour).toBe(-1)
    expect(r.localDate).toBe('')
  })

  it('latestHour is exclusive: 19:59 local allowed, 20:00 local blocked', () => {
    // America/New_York, Monday. 20:00Z = 15:00 EST (Jan) -> allowed.
    const at15 = evaluateCallingWindow({
      atInstant: new Date('2026-01-05T20:00:00Z'),
      timezone: 'America/New_York',
      ...DEFAULT,
    })
    expect(at15.localHour).toBe(15)
    expect(at15.allowed).toBe(true)
    // 2026-01-06T01:00Z = 20:00 EST previous idea -> use an instant that yields local 20.
    const at20 = evaluateCallingWindow({
      atInstant: new Date('2026-01-06T01:00:00Z'), // 20:00 EST Monday Jan 5
      timezone: 'America/New_York',
      ...DEFAULT,
    })
    expect(at20.localHour).toBe(20)
    expect(at20.allowed).toBe(false)
    expect(at20.reason).toBe('outside_calling_window_hour')
  })
})
