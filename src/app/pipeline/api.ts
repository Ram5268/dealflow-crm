// Brief 45 PR D — the Pipeline page's calls to PR A's API (through its
// browser layer, client.ts). Every error carries the API's plain-English
// message, ready for a toast. Nothing here contacts anyone [Ryan, 2026-09-24:
// nothing contacts a lead]: moving a card or saving a workflow only organizes
// [brief §4].
import {
  ListsApiError, createGroup, createWorkflow, deleteWorkflow, getPipeline, moveLeadBetweenGroups, updateWorkflow,
} from '@/lib/core-data/lists/client'
import type { GroupDTO, PipelineColumn, PipelineQuery, WorkflowDTO } from '@/lib/core-data/lists/types'
import type { MoveRequest } from './board-state'
import { workflowInput } from './workflows'

/** A drag from column X to column Y: out of group X, into group Y, in one step. */
export async function moveCard(move: MoveRequest): Promise<void> {
  await moveLeadBetweenGroups(move)
}

/** The API's message, or a plain one when the CRM couldn't be reached at all. */
export function problemText(err: unknown): string {
  if (err instanceof ListsApiError) return err.message
  return 'The CRM could not be reached. Check your connection and try again.'
}

/** The toast when a move is refused (the card has already gone back). */
export function moveFailure(name: string, groupName: string, err: unknown): { title: string; description: string; tone: 'danger' } {
  return { title: `Couldn't move ${name} to ${groupName}`, description: problemText(err), tone: 'danger' }
}

/** One more page of one column, with the same filters ("load more"). */
export async function fetchColumnPage(query: PipelineQuery, groupId: string, page: number): Promise<PipelineColumn | null> {
  const r = await getPipeline({ view: 'board', groups: query.groups, filters: query.filters, column: groupId, page })
  return r.view === 'board' ? (r.columns.find((c) => c.group.id === groupId) ?? null) : null
}

export const saveWorkflow = (name: string, query: PipelineQuery): Promise<WorkflowDTO> => createWorkflow({ name, ...workflowInput(query) })
/** "Update": the open workflow takes what's on screen now. */
export const saveOverWorkflow = (id: string, query: PipelineQuery): Promise<WorkflowDTO> => updateWorkflow(id, workflowInput(query))
export const renameWorkflow = (id: string, name: string): Promise<WorkflowDTO> => updateWorkflow(id, { name })
export const removeWorkflow = async (id: string): Promise<void> => {
  await deleteWorkflow(id)
}

/** The empty Pipeline's "+ Group". */
export const createGroupNamed = async (name: string): Promise<GroupDTO> => (await createGroup({ name })).group
