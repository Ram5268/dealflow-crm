// Brief 45 — folders, lists, groups and the Pipeline: the shapes the API
// returns and the browser sends. Client-safe: no Prisma import, so client.ts
// (browser) and the server share these. Dates travel as ISO strings.
//
// Nothing here contacts anyone. Folders, lists, groups and the Pipeline are
// organization only [Ryan, 2026-09-24 and 2026-10-18].

export const NAME_MAX = 60
/** Leads per bulk add/remove request; the UI chunks bigger selections [engineering precaution]. */
export const BULK_MAX = 5_000
/** Rows per ranked list page [brief §5.4]. */
export const PAGE_SIZE = 100
/** Cards per Pipeline column page. */
export const BOARD_PAGE_SIZE = 50
/** Cap on `ids=1` and on CSV exports. */
export const IDS_CAP = 25_000

export const GROUP_COLORS = ['gray', 'red', 'orange', 'yellow', 'green', 'teal', 'blue', 'purple', 'pink'] as const
export type GroupColor = (typeof GROUP_COLORS)[number]

export const BOROUGHS = ['Manhattan', 'Brooklyn', 'Queens', 'Bronx', 'Staten Island'] as const
export type Borough = (typeof BOROUGHS)[number]

/** Shown while DIALING_ENABLED is not 'true' (the CallingOffBanner's wording). */
export const CALLING_OFF_REASON = 'Calling is off'

// ─── Folders, lists, groups ──────────────────────────────────────────────────

export interface FolderDTO {
  id: string
  name: string
  sortOrder: number
  /** Every list in the folder, archived ones included (a folder deletes only when this is 0). */
  listCount: number
  archivedListCount: number
}

export interface ListDTO {
  id: string
  name: string
  /** null: the list sits outside any folder [Ryan, 2026-10-18]. */
  folderId: string | null
  /** 'manual' | 'upload:<importBatchId>' */
  source: string
  sortOrder: number
  archivedAt: string | null
  memberCount: number
  createdAt: string
  /** The import's createdAt, when source is upload:<id>. */
  uploadedAt?: string
}

export interface GroupDTO {
  id: string
  name: string
  color: GroupColor
  sortOrder: number
  memberCount: number
}

export interface GroupChipDTO {
  id: string
  name: string
  color: GroupColor
}

export interface BulkAddResult {
  added: number
  alreadyIn: number
  /** Unknown ids, and ids of another organization's leads. */
  notFound: number
}

export interface BulkRemoveResult {
  removed: number
}

export interface LeadMemberships {
  /** Active lists, in sidebar order. */
  lists: { id: string; name: string; folderName: string | null }[]
  /** In sidebar order. */
  groupIds: string[]
}

export interface SidebarData {
  allLeads: { count: number; rankedAt: string | null }
  folders: FolderDTO[]
  /** Active lists of every folder, then those outside folders, in sidebar order. */
  lists: ListDTO[]
  archivedCount: number
  groups: GroupDTO[]
  workflows: WorkflowDTO[]
}

// ─── Ranked lists and All leads ──────────────────────────────────────────────

export type RankState = 'ranked' | 'scoring' | 'not_ranked'
export type NotRankedReason = 'no_match' | 'no_mojo_id'

export interface BestBuyerDTO {
  name: string
  score: number | null
  isTestData: boolean
}

export interface CallingWindowDTO {
  earliestHour: number
  latestHour: number
  allowedDaysOfWeek: number[]
  /** false until counsel-backed confirmation; the UI says "(not confirmed yet)". */
  confirmed: boolean
}

export interface RankedRow {
  /** Position in the whole list (or All leads), whatever the filters [brief §5.4]. */
  rank: number
  leadId: string
  displayName: string
  address: string | null
  priorityScore: number | null
  topMatchFit: number | null
  rankState: RankState
  notRankedReason: NotRankedReason | null
  whyNow: string | null
  bestBuyer: BestBuyerDTO | null
  /** In sidebar order. */
  groups: GroupChipDTO[]
  attempts: number
  lastResult: string | null
  /** The primary contact's IANA zone, else the lead's. */
  timezone: string | null
  /** Always false while calling is off [brief §5.1 rule 3]. */
  calledToday: boolean
  /** When the lead joined this list; null for All leads. */
  addedAt: string | null
}

export interface RankedPage {
  list: (ListDTO & { folderName: string | null }) | null
  /** Rows matching the filters. */
  total: number
  /** The whole list (or every lead). */
  memberCount: number
  page: number
  pageSize: number
  rankedAt: string | null
  callingOffReason: string | null
  callingWindows: Record<string, CallingWindowDTO>
  rows: RankedRow[]
}

export interface MemberFilters {
  q?: string
  /** A group id, or 'none' for leads in no group. */
  group?: string
  strongBuyer?: boolean
  /** Ignored while calling is off. */
  calledToday?: boolean
  borough?: Borough | string
}

// ─── Pipeline ────────────────────────────────────────────────────────────────

export const PIPELINE_VIEWS = ['board', 'table'] as const
export type PipelineView = (typeof PIPELINE_VIEWS)[number]
export const PIPELINE_SORT_KEYS = ['rank', 'name', 'lastContact', 'taskDue', 'inGroupSince'] as const
export type PipelineSortKey = (typeof PIPELINE_SORT_KEYS)[number]
export type SortDir = 'asc' | 'desc'

/** The Pipeline's filters, spelled exactly as the query string (CONTRACT §6b). */
export interface PipelineFilters {
  list?: string
  folder?: string
  borough?: string
  neighborhood?: string
  propertyType?: string
  units?: '1' | '2' | '3' | '4' | '5+'
  tier?: 'hot' | 'warm' | 'possible' | 'none'
  strongBuyer?: '1'
  lastContact?: 'never' | 'over7' | 'over30' | 'over60' | 'over90'
  taskDue?: 'today' | 'week' | 'overdue'
  timeInGroup?: '30' | '60' | '90'
  multiGroup?: '1'
  q?: string
}

export const PIPELINE_FILTER_KEYS = [
  'list', 'folder', 'borough', 'neighborhood', 'propertyType', 'units', 'tier', 'strongBuyer',
  'lastContact', 'taskDue', 'timeInGroup', 'multiGroup', 'q',
] as const satisfies readonly (keyof PipelineFilters)[]

export interface PipelineSort {
  key: PipelineSortKey
  dir: SortDir
}

export interface PipelineQuery {
  view: PipelineView
  /** Group ids to show; undefined = every group. */
  groups?: string[]
  filters: PipelineFilters
  /** Board only: load another page of this one column. */
  column?: string
  page?: number
  /** Table only. */
  sort?: PipelineSortKey
  dir?: SortDir
}

export interface PipelineCard {
  leadId: string
  displayName: string
  address: string | null
  /** Our value estimate: not shown until Brief 44 data exists. */
  value: null
  bestBuyer: BestBuyerDTO | null
  lastContactAt: string | null
  nextTask: { text: string; dueDate: string | null } | null
  /** When the lead joined this column's group. */
  inGroupSince: string
  /** Every group of the lead, in sidebar order. */
  groups: GroupChipDTO[]
  /** The lead's other groups ("also in …"). */
  alsoIn: { id: string; name: string }[]
  /** Position in All leads (the same number in every column and in the table). */
  rank: number
}

export interface PipelineColumn {
  group: GroupDTO
  /** Cards in this column that match the filters. */
  count: number
  cards: PipelineCard[]
  hasMore: boolean
  page: number
}

export interface PipelineFilterOptions {
  propertyTypes: string[]
  neighborhoods: string[]
  boroughs: string[]
}

export interface PipelineBoard {
  view: 'board'
  columns: PipelineColumn[]
  filterOptions: PipelineFilterOptions
}

export interface PipelineRow {
  leadId: string
  displayName: string
  address: string | null
  value: null
  bestBuyer: BestBuyerDTO | null
  lastContactAt: string | null
  nextTask: { text: string; dueDate: string | null } | null
  /** The earliest join among the shown groups. */
  inGroupSince: string
  groups: GroupChipDTO[]
  rank: number
  priorityScore: number | null
  topMatchFit: number | null
}

export interface PipelineTable {
  view: 'table'
  rows: PipelineRow[]
  total: number
  page: number
  pageSize: number
  filterOptions: PipelineFilterOptions
}

export type PipelineResult = PipelineBoard | PipelineTable

// ─── Saved workflows (SavedView type 'pipeline') ─────────────────────────────

export const WORKFLOW_VIEW_TYPE = 'pipeline'

export interface WorkflowDTO {
  id: string
  name: string
  view: PipelineView
  filters: PipelineFilters
  /** The groups shown as columns. */
  groupIds: string[]
  sort: PipelineSort | null
}

export interface WorkflowInput {
  name: string
  view: PipelineView
  filters: PipelineFilters
  groupIds: string[]
  sort?: PipelineSort | null
}
