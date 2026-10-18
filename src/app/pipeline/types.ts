// Brief 45 PR D — what the /pipeline server component hands the page.
// Client-safe (types only; no Prisma).
import type {
  FolderDTO, GroupDTO, ListDTO, PipelineQuery, PipelineResult, WorkflowDTO,
} from '@/lib/core-data/lists/types'

export interface PipelinePageData {
  /** What's on screen: the link's filters, or the open workflow's saved ones. */
  query: PipelineQuery
  /** The open workflow tab; null = the "All groups" tab. */
  workflowId: string | null
  /** PR A's board or table for `query`; null while there are no groups (the empty state). */
  result: PipelineResult | null
  /** Every group, in sidebar order. */
  groups: GroupDTO[]
  folders: FolderDTO[]
  /** Active lists, in sidebar order. */
  lists: ListDTO[]
  /** So a filter on an archived list can still be named. */
  archivedLists: ListDTO[]
  workflows: WorkflowDTO[]
  /** Plain-English notes about parts of the link that were ignored or no longer exist. */
  notices: string[]
  /** The server's "now" (ISO), so "3 days ago" reads the same on the server and in the browser. */
  now: string
}
