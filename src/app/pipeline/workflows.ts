// Brief 45 PR D — saved workflows ("Brownstone nurtures", "Expired hot
// leads"): a filter set plus its columns, view and sort, saved as a named tab
// [brief §5.6]. PR A stores them (SavedView type 'pipeline'); these are the
// pure conversions between a workflow and what's on screen. Client-safe.
import type { PipelineQuery, WorkflowDTO, WorkflowInput } from '@/lib/core-data/lists/types'
import { normalizeQuery, sameQuery } from './url'

/** A tab opens its workflow as saved (the server fills in the rest); the sidebar's Workflows use the same link. */
export { workflowHref } from '@/components/lists/sidebar/palette'

/**
 * What a workflow shows. A group deleted since it was saved is left out; if
 * none of its groups is left, it shows every group. Either way it opens
 * (the page says what happened).
 */
export function workflowToQuery(wf: WorkflowDTO, groups: readonly { id: string }[]): { query: PipelineQuery; missingGroups: number } {
  const known = new Set(groups.map((g) => g.id))
  const kept = wf.groupIds.filter((id) => known.has(id))
  return {
    query: normalizeQuery({ view: wf.view, groups: kept, filters: { ...wf.filters }, sort: wf.sort?.key, dir: wf.sort?.dir }),
    missingGroups: wf.groupIds.length - kept.length,
  }
}

/**
 * What saving the screen stores. "Every group" is stored as no list, so a
 * group made later shows up in the workflow too. The table's page isn't saved.
 */
export function workflowInput(query: PipelineQuery): Omit<WorkflowInput, 'name'> {
  const q = normalizeQuery(query)
  return { view: q.view, filters: q.filters, groupIds: q.groups ?? [], sort: q.sort ? { key: q.sort, dir: q.dir ?? 'asc' } : null }
}

/** Does the screen still show the workflow as saved? (If not, the page offers "Update".) */
export function matchesWorkflow(query: PipelineQuery, wf: WorkflowDTO, groups: readonly { id: string }[]): boolean {
  return sameQuery({ ...query, page: undefined }, workflowToQuery(wf, groups).query)
}
