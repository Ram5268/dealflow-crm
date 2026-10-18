// Brief 45 — "Export CSV" of the rows picked on a list page, made in the
// browser with exactly the server export's columns (ranked.ts EXPORT_COLUMNS):
// no phone numbers or emails, the same columns policy as the Leads export
// [engineering precaution]. Formula-safe cells come from PR A's csv.ts.
import { toCsv } from '@/lib/core-data/lists/csv'
import { timezoneLabel } from '@/lib/core-data/dealflow-sync/labels'
import type { RankedRow } from '@/lib/core-data/lists/types'

export const LIST_CSV_COLUMNS = [
  'Rank', 'Name', 'Address', 'Priority', 'Match fit', 'Why now', 'Best buyer', 'Groups', 'Attempts', 'Last result', 'Timezone',
] as const

export function rowsToCsv(rows: readonly RankedRow[]): string {
  return toCsv(
    LIST_CSV_COLUMNS,
    rows.map((r) => [
      r.rank, r.displayName, r.address, r.priorityScore, r.topMatchFit, r.whyNow, r.bestBuyer?.name ?? null,
      r.groups.map((g) => g.name).join('; '), r.attempts, r.lastResult, timezoneLabel(r.timezone),
    ]),
  )
}
