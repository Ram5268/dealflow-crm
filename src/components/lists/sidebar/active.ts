// Brief 45 PR D — which group or saved workflow the page is showing, for the
// sidebar's "open" mark. A group opens the Pipeline on that group
// (/pipeline?groups=<id>, palette.ts groupHref); All leads filtered to a group
// (/leads?group=<id>) still works for an old link. A workflow tab is
// /pipeline?wf=<id>. Pure, so it can be tested without a browser.

export interface ActiveSidebarItems {
  groupId: string | null
  workflowId: string | null
}

const NONE: ActiveSidebarItems = { groupId: null, workflowId: null }

export function activeSidebarItems(pathname: string | null, search: { get(name: string): string | null } | null): ActiveSidebarItems {
  if (!pathname || !search) return NONE
  if (pathname === '/leads') return { groupId: search.get('group') || null, workflowId: null }
  if (pathname !== '/pipeline') return NONE
  const workflowId = search.get('wf') || null
  if (workflowId) return { groupId: null, workflowId }
  // The Pipeline on exactly one group is that group's page; several columns aren't any one group.
  const groups = (search.get('groups') ?? '').split(',').map((g) => g.trim()).filter(Boolean)
  return { groupId: groups.length === 1 ? groups[0] : null, workflowId: null }
}
