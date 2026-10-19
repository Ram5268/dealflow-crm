// Brief 45 PR D — what /pipeline loads on the server for a URL [brief §5.6]:
// the query on screen (the link's filters, or a workflow tab's saved ones),
// PR A's board or table for it, and what the page needs to name things
// (groups, folders, lists, workflows).
//
// The page always opens. Something in the link that no longer exists (a
// group, list, folder or workflow that was deleted since) or that the
// Pipeline doesn't know is left out, with a plain-English note, instead of
// an error or an empty board. Server only (reads the database); the page
// itself imports only the types.
import type { PrismaClient } from '@prisma/client'
import { prisma } from '@/lib/prisma'
import { listFolders } from '@/lib/core-data/lists/folders'
import { listGroups } from '@/lib/core-data/lists/groups'
import { listLists } from '@/lib/core-data/lists/lists'
import { getPipeline } from '@/lib/core-data/lists/pipeline'
import { listWorkflows } from '@/lib/core-data/lists/workflows'
import type { PipelineQuery } from '@/lib/core-data/lists/types'
import type { PipelinePageData } from './types'
import { normalizeQuery, parsePipelineUrl } from './url'
import { workflowToQuery } from './workflows'

export const WORKFLOW_GONE = 'That saved workflow no longer exists.'
export const LIST_GONE = 'The list in this view was deleted, so that filter was removed.'
export const FOLDER_GONE = 'The folder in this view was deleted, so that filter was removed.'

/**
 * The note when some (or all) of the groups asked for no longer exist.
 * `othersExist`: the organization still has groups to show instead (when it
 * has none, the page shows "Create a group…", so there's no "every group").
 */
export function groupsNotice(missing: number, kept: number, from: 'workflow' | 'link', othersExist: boolean): string {
  const one = missing === 1
  if (from === 'workflow') {
    if (kept > 0) return one ? 'A group this workflow showed was deleted, so its column is gone.' : `${missing} groups this workflow showed were deleted, so their columns are gone.`
    const gone = one ? 'The group this workflow showed was deleted' : 'The groups this workflow showed were deleted'
    return othersExist ? `${gone}, so it shows every group now.` : `${gone}.`
  }
  if (kept > 0) return one ? 'A group in this link no longer exists, so its column is left out.' : `${missing} groups in this link no longer exist, so their columns are left out.`
  const gone = one ? 'The group in this link no longer exists' : 'The groups in this link no longer exist'
  return othersExist ? `${gone}, so every group is shown.` : `${gone}.`
}

export async function loadPipelinePage(
  organizationId: string,
  search: URLSearchParams | Record<string, string | string[] | undefined>,
  opts: { now?: Date } = {},
  db: PrismaClient = prisma,
): Promise<PipelinePageData> {
  const now = opts.now ?? new Date()
  const parsed = parsePipelineUrl(search)
  const [groups, folders, lists, archivedLists, workflows] = await Promise.all([
    listGroups(organizationId, db),
    listFolders(organizationId, db),
    listLists(organizationId, {}, db),
    listLists(organizationId, { archived: true }, db),
    listWorkflows(organizationId, db),
  ])
  const notices = [...parsed.ignored]
  let query: PipelineQuery = parsed.query
  let workflowId = parsed.workflowId

  // Columns: a tab opens its workflow as saved; a link's groups are checked
  // the same way. Deleted (or another organization's) groups are left out.
  const workflow = workflowId ? workflows.find((w) => w.id === workflowId) : undefined
  if (workflowId && !workflow) {
    notices.push(WORKFLOW_GONE)
    workflowId = null
  }
  if (workflow && !parsed.explicit) {
    const saved = workflowToQuery(workflow, groups)
    query = saved.query
    if (saved.missingGroups > 0) notices.push(groupsNotice(saved.missingGroups, query.groups?.length ?? 0, 'workflow', groups.length > 0))
  } else if (query.groups) {
    const known = new Set(groups.map((g) => g.id))
    const kept = query.groups.filter((id) => known.has(id))
    if (kept.length < query.groups.length) {
      notices.push(groupsNotice(query.groups.length - kept.length, kept.length, 'link', groups.length > 0))
      query = normalizeQuery({ ...query, groups: kept })
    }
  }

  // A list or folder filter whose list or folder is gone would show nobody.
  const filters = { ...query.filters }
  if (filters.list && !lists.some((l) => l.id === filters.list) && !archivedLists.some((l) => l.id === filters.list)) {
    delete filters.list
    notices.push(LIST_GONE)
  }
  if (filters.folder && !folders.some((f) => f.id === filters.folder)) {
    delete filters.folder
    notices.push(FOLDER_GONE)
  }
  query = normalizeQuery({ ...query, filters })

  // No groups yet: the page shows "Create a group to start your pipeline".
  const result = groups.length === 0 ? null : await getPipeline(organizationId, query, { now }, db)
  return { query, workflowId, result, groups, folders, lists, archivedLists, workflows, notices, now: now.toISOString() }
}
