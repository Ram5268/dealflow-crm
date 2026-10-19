// Brief 45 PR D — "Export CSV" of the rows selected in the Pipeline table. No
// phone numbers or emails, like the list exports [engineering precaution].
// Brief 45 PR G: and never our value estimate, though the rows carry it
// [Ryan, 2026-10-17: our value estimates never reach anything a buyer or
// homeowner sees; engineering precaution: exports can be forwarded].
// Client-safe; formula-safe cells come from PR A's csv.ts.
import { toCsv } from '@/lib/core-data/lists/csv'
import type { PipelineRow } from '@/lib/core-data/lists/types'
import { shortDate } from './format'

export const PIPELINE_CSV_COLUMNS = [
  'Rank', 'Name', 'Address', 'Groups', 'Best buyer', 'Last contact', 'Next task', 'Task due', 'In group since',
] as const

export function pipelineRowsToCsv(rows: readonly PipelineRow[]): string {
  return toCsv(
    PIPELINE_CSV_COLUMNS,
    rows.map((r) => [
      r.rank, r.displayName, r.address, r.groups.map((g) => g.name).join('; '), r.bestBuyer?.name ?? '',
      r.lastContactAt ? shortDate(r.lastContactAt) : 'Never', r.nextTask?.text ?? '',
      r.nextTask?.dueDate ? shortDate(r.nextTask.dueDate) : '', shortDate(r.inGroupSince),
    ]),
  )
}
