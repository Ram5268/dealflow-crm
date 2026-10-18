// Brief 45 — everything the Mojo-style left sidebar shows, in one request
// [brief §5.2]: All leads (always there, never deletable), folders, active
// lists, how many are archived, groups and saved Pipeline workflows. The CRM
// starts with none of them: Ryan creates every one [Ryan, 2026-10-18].
import type { PrismaClient } from '@prisma/client'
import { prisma } from '@/lib/prisma'
import type { SidebarData } from './types'
import { listFolders } from './folders'
import { listLists } from './lists'
import { listGroups } from './groups'
import { listWorkflows } from './workflows'

export async function getSidebar(organizationId: string, db: PrismaClient = prisma): Promise<SidebarData> {
  const [count, synced, folders, lists, archivedCount, groups, workflows] = await Promise.all([
    db.lead.count({ where: { organizationId } }),
    db.dealFlowDerivedSignal.aggregate({ where: { organizationId }, _max: { syncedAt: true } }),
    listFolders(organizationId, db),
    listLists(organizationId, {}, db),
    db.callList.count({ where: { organizationId, archivedAt: { not: null } } }),
    listGroups(organizationId, db),
    listWorkflows(organizationId, db),
  ])
  return {
    allLeads: { count, rankedAt: synced._max.syncedAt?.toISOString() ?? null },
    folders,
    lists,
    archivedCount,
    groups,
    workflows,
  }
}
