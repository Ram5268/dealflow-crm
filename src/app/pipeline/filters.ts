// Brief 45 PR D — the Pipeline's filters as people see them: labels, choices,
// the removable chips, and the "How these filters work" note (the field each
// filter reads; the same table is in the PR description). Every filter is
// PR A's (CONTRACT §6b, src/lib/core-data/lists/pipeline.ts).
//
// Value range is not offered until Brief 44's estimates are in the CRM.
// Sensitive life details (estate, probate, divorce, illness, age) are never
// filters [engineering precaution; fair-housing and NY human-rights law].
// Client-safe.
import type { FolderDTO, ListDTO, PipelineFilters } from '@/lib/core-data/lists/types'
import { HOT_MIN_FIT, STRONG_BUYER_MIN_FIT, WARM_MIN_FIT } from '@/lib/core-data/lists/rules'

export interface FilterOption {
  value: string
  label: string
}

export const UNIT_OPTIONS: FilterOption[] = [
  { value: '1', label: '1 (single family)' },
  { value: '2', label: '2' },
  { value: '3', label: '3' },
  { value: '4', label: '4' },
  { value: '5+', label: '5 or more' },
]

// DealFlow lib/matching/tiers.ts, via PR A's rules.ts.
export const TIER_OPTIONS: FilterOption[] = [
  { value: 'hot', label: `Hot (fit ${HOT_MIN_FIT}+)` },
  { value: 'warm', label: `Warm (fit ${WARM_MIN_FIT}–${HOT_MIN_FIT - 1})` },
  { value: 'possible', label: `Possible (fit under ${WARM_MIN_FIT})` },
  { value: 'none', label: 'No buyer match' },
]

export const LAST_CONTACT_OPTIONS: FilterOption[] = [
  { value: 'never', label: 'Never contacted' },
  { value: 'over7', label: 'Over 7 days ago' },
  { value: 'over30', label: 'Over 30 days ago' },
  { value: 'over60', label: 'Over 60 days ago' },
  { value: 'over90', label: 'Over 90 days ago' },
]

export const TASK_DUE_OPTIONS: FilterOption[] = [
  { value: 'today', label: 'Due today' },
  { value: 'week', label: 'Due this week' },
  { value: 'overdue', label: 'Overdue' },
]

export const TIME_IN_GROUP_OPTIONS: FilterOption[] = [
  { value: '30', label: '30 days or more' },
  { value: '60', label: '60 days or more' },
  { value: '90', label: '90 days or more' },
]

const labelOf = (options: FilterOption[], value: string) => options.find((o) => o.value === value)?.label ?? value

export interface FilterNames {
  lists: ListDTO[]
  archivedLists: ListDTO[]
  folders: FolderDTO[]
}

/** The text on a filter's removable chip, e.g. "Borough: Brooklyn". */
export function chipLabel(key: keyof PipelineFilters, value: string, names: FilterNames): string {
  switch (key) {
    case 'list': {
      const active = names.lists.find((l) => l.id === value)
      const archived = names.archivedLists.find((l) => l.id === value)
      return `List: ${active?.name ?? (archived ? `${archived.name} (archived)` : '(deleted list)')}`
    }
    case 'folder':
      return `Folder: ${names.folders.find((f) => f.id === value)?.name ?? '(deleted folder)'}`
    case 'units':
      return `Units: ${labelOf(UNIT_OPTIONS, value)}`
    case 'tier':
      return `Tier: ${labelOf(TIER_OPTIONS, value)}`
    case 'strongBuyer':
      return 'Has a strong buyer'
    case 'lastContact':
      return value === 'never' ? 'Never contacted' : `Last contact: ${labelOf(LAST_CONTACT_OPTIONS, value).toLowerCase()}`
    case 'taskDue':
      return value === 'overdue' ? 'Task overdue' : `Task ${labelOf(TASK_DUE_OPTIONS, value).toLowerCase()}`
    case 'timeInGroup':
      return `In the group ${labelOf(TIME_IN_GROUP_OPTIONS, value)}`
    case 'multiGroup':
      return 'In more than one group'
    case 'q':
      return `Search: “${value}”`
    case 'borough':
      return `Borough: ${value}`
    case 'neighborhood':
      return `Neighborhood: ${value}`
    case 'propertyType':
      return `Property type: ${value}`
  }
}

export interface FilterHelpRow {
  /** The query-string filters this row explains (none for the two that aren't offered). */
  keys: (keyof PipelineFilters)[]
  filter: string
  reads: string
}

/** "How these filters work": what each filter reads [CONTRACT §4, §6b]. */
export const FILTER_HELP: FilterHelpRow[] = [
  {
    keys: ['list', 'folder'],
    filter: 'List or folder',
    reads:
      "Whether the person is on that list, or on any of the folder's active lists (archived lists sit under Archived, not in the folder). An archived list picked on its own still works.",
  },
  {
    keys: ['borough'],
    filter: 'Borough',
    reads:
      'Mojo\'s "Property Zip Code": 100–102 Manhattan, 103 Staten Island, 104 Bronx, 112 Brooklyn, 111/113/114/116 and 11004–11005 Queens. Without a usable ZIP, "Property City". Town names shared with Nassau County aren\'t guessed.',
  },
  {
    keys: ['neighborhood'],
    filter: 'Neighborhood',
    reads: '"Property Zip Code", through DealFlow\'s ZIP-to-neighborhood table. A ZIP that spans several neighborhoods has none.',
  },
  {
    keys: ['propertyType'],
    filter: 'Property type',
    reads: 'Mojo\'s "Property Type", as uploaded. The choices are the types in your CRM.',
  },
  {
    keys: ['units'],
    filter: 'Units',
    reads:
      'From "Property Type", the way DealFlow reads it: Duplex 2, Triplex 3, Quadruplex 4, "Apartment House (5+ Units)" 5 or more, and anything with "Single Family" 1. Other types have no unit count.',
  },
  {
    keys: ['tier'],
    filter: 'DealFlow tier',
    reads: `The best buyer match's fit, with DealFlow's tiers: Hot ${HOT_MIN_FIT} or more, Warm ${WARM_MIN_FIT}–${HOT_MIN_FIT - 1}, Possible under ${WARM_MIN_FIT}. "No buyer match" = DealFlow found none.`,
  },
  {
    keys: ['strongBuyer'],
    filter: 'Has a strong buyer',
    reads: `A buyer match with a fit of ${STRONG_BUYER_MIN_FIT} or more (DealFlow's Hot).`,
  },
  {
    keys: ['lastContact'],
    filter: 'Last contact',
    reads:
      'The later of Mojo\'s "Last Contacted Date" and the newest call, email or text in the CRM. Group changes don\'t count as contact. "Over N days ago" leaves out people never contacted: pick "Never contacted" for them.',
  },
  {
    keys: ['taskDue'],
    filter: 'Task due',
    reads: 'Open tasks only: due today, due today through Sunday ("this week"), or due before today (overdue). New York dates.',
  },
  {
    keys: ['timeInGroup'],
    filter: 'Time in group',
    reads: "How long ago the person was added to that column's group. In the table: to any of the groups shown.",
  },
  {
    keys: ['multiGroup'],
    filter: 'In more than one group',
    reads: 'People with two or more groups. They show in each of their columns, with an "Also in" mark.',
  },
  {
    keys: ['q'],
    filter: 'Search',
    reads: 'Name and property address.',
  },
  {
    keys: [],
    filter: 'Value range',
    reads: "Coming later: it's not offered yet because our value estimates aren't in the CRM (Brief 44 adds them).",
  },
  {
    keys: [],
    filter: 'Called today',
    reads: 'Not a Pipeline filter. List pages have it, and only while calling is on.',
  },
]
