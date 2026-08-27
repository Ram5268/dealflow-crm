import { describe, it, expect } from 'vitest'
import { evaluateCallingWindow } from '@/lib/compliance/timezone/windowCheck'

const DEFAULT = { earliestHour: 9, latestHour: 20, allowedDaysOfWeek: [1, 2, 3, 4, 5] }
// 12:00 EST instants (in-window hour) so the day gate is the deciding factor.
const NOON_NY = (isoDate: string) => new Date(`${isoDate}T17:00:00Z`)

describe('windowCheck — day of week', () => {
  it('blocks Saturday (6) with outside_calling_window_day', () => {
    const r = evaluateCallingWindow({ atInstant: NOON_NY('2026-01-03'), timezone: 'America/New_York', ...DEFAULT })
    expect(r.localDayOfWeek).toBe(6)
    expect(r.localHour).toBe(12)
    expect(r.allowed).toBe(false)
    expect(r.reason).toBe('outside_calling_window_day')
  })

  it('blocks Sunday (0) with outside_calling_window_day — confirms 0=Sunday convention', () => {
    const r = evaluateCallingWindow({ atInstant: NOON_NY('2026-01-04'), timezone: 'America/New_York', ...DEFAULT })
    expect(r.localDayOfWeek).toBe(0)
    expect(r.allowed).toBe(false)
    expect(r.reason).toBe('outside_calling_window_day')
  })

  it('allows a weekday in-window (Monday noon)', () => {
    const r = evaluateCallingWindow({ atInstant: NOON_NY('2026-01-05'), timezone: 'America/New_York', ...DEFAULT })
    expect(r.localDayOfWeek).toBe(1)
    expect(r.allowed).toBe(true)
    expect(r.reason).toBeUndefined()
  })

  it('New Year 2027 (Fri) passes window-check alone — holiday layer must block it', () => {
    const r = evaluateCallingWindow({ atInstant: NOON_NY('2027-01-01'), timezone: 'America/New_York', ...DEFAULT })
    expect(r.localDayOfWeek).toBe(5) // Friday
    expect(r.allowed).toBe(true)
  })

  it('honors a custom allowedDaysOfWeek that includes weekends', () => {
    const r = evaluateCallingWindow({
      atInstant: NOON_NY('2026-01-04'), // Sunday
      timezone: 'America/New_York',
      earliestHour: 9,
      latestHour: 20,
      allowedDaysOfWeek: [0, 6], // weekends only
    })
    expect(r.allowed).toBe(true)
  })
})
