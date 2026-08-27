// The calling-window evaluator. THE ONLY file in the slice permitted to convert
// a UTC instant to a local wall-clock time. Uses Intl.DateTimeFormat with a
// timeZone option, which is DST-aware natively via Node 22's bundled ICU IANA
// tz database. NEVER use Date.prototype.getHours/getDay/getDate for a decision
// — those read the SERVER timezone and would silently break for every contact.

export type WindowReason =
  | 'outside_calling_window_hour'
  | 'outside_calling_window_day'
  | 'timezone_invalid'

export interface WindowResult {
  allowed: boolean
  localHour: number
  localDayOfWeek: number // 0=Sun .. 6=Sat (JS convention)
  localDate: string // YYYY-MM-DD (local)
  reason?: WindowReason
}

const SHORT_DOW_TO_NUM: Record<string, number> = {
  Sun: 0,
  Mon: 1,
  Tue: 2,
  Wed: 3,
  Thu: 4,
  Fri: 5,
  Sat: 6,
}

export interface LocalFields {
  localHour: number
  localDayOfWeek: number // 0=Sun .. 6=Sat
  localDate: string // YYYY-MM-DD
}

// Pure: map Intl parts to local fields. Extracted so the defensive guards
// (midnight rendered as 24, an unexpected/missing part) are unit-testable
// without mocking Intl — a safety file earns its belt-and-suspenders.
export function deriveLocalFromParts(parts: Intl.DateTimeFormatPart[]): LocalFields {
  const map: Record<string, string> = {}
  for (const p of parts) map[p.type] = p.value

  let localHour = parseInt(map.hour ?? '', 10)
  if (!Number.isFinite(localHour)) localHour = -1
  else if (localHour === 24) localHour = 0 // some ICU builds render midnight as 24

  const localDayOfWeek = SHORT_DOW_TO_NUM[map.weekday ?? ''] ?? -1
  const localDate = `${map.year ?? ''}-${map.month ?? ''}-${map.day ?? ''}`
  return { localHour, localDayOfWeek, localDate }
}

export function evaluateCallingWindow(input: {
  atInstant: Date
  timezone: string
  earliestHour: number
  latestHour: number
  allowedDaysOfWeek: number[]
}): WindowResult {
  const { atInstant, timezone, earliestHour, latestHour, allowedDaysOfWeek } = input

  let parts: Intl.DateTimeFormatPart[]
  try {
    const fmt = new Intl.DateTimeFormat('en-US', {
      timeZone: timezone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      weekday: 'short',
      hour: '2-digit',
      hourCycle: 'h23',
    })
    parts = fmt.formatToParts(atInstant)
  } catch {
    // Invalid IANA zone (e.g. "Etc/Weird") — fail-closed, never throw.
    return { allowed: false, reason: 'timezone_invalid', localHour: -1, localDayOfWeek: -1, localDate: '' }
  }

  const { localHour, localDayOfWeek, localDate } = deriveLocalFromParts(parts)

  // Hour precedence first (matches the frozen DST expectations in §9 1b: a
  // Sunday 01:30 fall-back instant reports outside_calling_window_hour). A
  // wrong-day-but-in-hours instant then yields outside_calling_window_day.
  if (localHour < earliestHour || localHour >= latestHour) {
    return { allowed: false, reason: 'outside_calling_window_hour', localHour, localDayOfWeek, localDate }
  }
  if (!allowedDaysOfWeek.includes(localDayOfWeek)) {
    return { allowed: false, reason: 'outside_calling_window_day', localHour, localDayOfWeek, localDate }
  }
  return { allowed: true, localHour, localDayOfWeek, localDate }
}
