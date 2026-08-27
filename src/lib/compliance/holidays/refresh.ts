import Holidays from 'date-holidays'
import { prisma as defaultPrisma } from '@/lib/compliance/db'
import { TRACKED_STATES } from '@/lib/compliance/holidays/stateHolidays'
import { localDateToUtcMidnight } from '@/lib/compliance/holidays/check'

// Nightly cron worker. Uses the `date-holidays` package to generate federal +
// per-state public holidays for the current and next year, and upserts them
// into HolidaySuppressionDate. Idempotent (unique on orgId+date+scope). NEVER
// deletes past dates — the table is an audit trail.

export interface HolidayUpsertRow {
  organizationId: string
  date: Date
  scope: string // 'federal' | 'state:XX'
  name: string
}

function publicHolidays(state: string | undefined, year: number): Array<{ dateStr: string; name: string }> {
  const hd = state ? new Holidays('US', state) : new Holidays('US')
  const list = hd.getHolidays(year) as Array<{ date: string; name: string; type: string }> | false
  /* v8 ignore next -- getHolidays returns an array for supported years; this guards the false it returns only for unsupported ones */
  if (!list) return []
  return list
    .filter((h) => h.type === 'public')
    .map((h) => ({ dateStr: String(h.date).slice(0, 10), name: h.name }))
}

// Build the full row set WITHOUT touching the DB — deterministic and unit
// testable against real date-holidays output. A state holiday that falls on a
// federal date is dropped (the federal row already blocks that day for
// everyone).
export function generateHolidayRows(input: {
  orgId: string
  years: number[]
  trackedStates?: readonly string[]
}): HolidayUpsertRow[] {
  const states = input.trackedStates ?? TRACKED_STATES
  const rows: HolidayUpsertRow[] = []
  const seen = new Set<string>()

  for (const year of input.years) {
    const federal = publicHolidays(undefined, year)
    const federalDates = new Set(federal.map((h) => h.dateStr))

    for (const h of federal) {
      const key = `federal|${h.dateStr}`
      if (seen.has(key)) continue
      seen.add(key)
      rows.push({
        organizationId: input.orgId,
        date: localDateToUtcMidnight(h.dateStr),
        scope: 'federal',
        name: h.name,
      })
    }

    for (const st of states) {
      for (const h of publicHolidays(st, year)) {
        if (federalDates.has(h.dateStr)) continue
        const key = `state:${st}|${h.dateStr}`
        if (seen.has(key)) continue
        seen.add(key)
        rows.push({
          organizationId: input.orgId,
          date: localDateToUtcMidnight(h.dateStr),
          scope: `state:${st}`,
          name: h.name,
        })
      }
    }
  }
  return rows
}

export interface HolidayWriteDb {
  holidaySuppressionDate: { createMany: (args: any) => Promise<{ count: number }> }
}

export async function runHolidayRefresh(
  input: { orgId: string; years?: number[]; now?: Date },
  db: HolidayWriteDb = defaultPrisma as unknown as HolidayWriteDb
): Promise<{ generated: number; written: number }> {
  const now = input.now ?? new Date()
  const years = input.years ?? [now.getUTCFullYear(), now.getUTCFullYear() + 1]
  const rows = generateHolidayRows({ orgId: input.orgId, years })
  const res = await db.holidaySuppressionDate.createMany({ data: rows, skipDuplicates: true })
  return { generated: rows.length, written: res.count }
}
