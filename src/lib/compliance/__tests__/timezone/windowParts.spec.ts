import { describe, it, expect } from 'vitest'
import { deriveLocalFromParts } from '@/lib/compliance/timezone/windowCheck'

const part = (type: string, value: string) => ({ type, value }) as Intl.DateTimeFormatPart

describe('deriveLocalFromParts (defensive)', () => {
  it('maps normal parts', () => {
    const r = deriveLocalFromParts([
      part('year', '2026'),
      part('month', '01'),
      part('day', '05'),
      part('weekday', 'Mon'),
      part('hour', '12'),
    ])
    expect(r).toEqual({ localHour: 12, localDayOfWeek: 1, localDate: '2026-01-05' })
  })

  it('coerces a midnight rendered as 24 to 0', () => {
    const r = deriveLocalFromParts([part('weekday', 'Tue'), part('hour', '24')])
    expect(r.localHour).toBe(0)
  })

  it('returns -1 hour when the hour part is missing/unparseable', () => {
    expect(deriveLocalFromParts([part('weekday', 'Wed')]).localHour).toBe(-1)
  })

  it('returns -1 dayOfWeek for an unknown weekday token', () => {
    expect(deriveLocalFromParts([part('weekday', 'Xyz'), part('hour', '09')]).localDayOfWeek).toBe(-1)
  })

  it('builds an empty-ish date string when date parts are absent', () => {
    expect(deriveLocalFromParts([part('hour', '09'), part('weekday', 'Fri')]).localDate).toBe('--')
  })
})
