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
import { rankingTimesSql } from './sql'

export async function getSidebar(organizationId: string, db: PrismaClient = prisma): Promise<SidebarData> {
  const [count, [synced], folders, lists, archivedCount, groups, workflows] = await Promise.all([
    db.lead.count({ where: { organizationId } }),
    // The morning update's "ranked 7:02" (rankingTimesSql: an upload's scoring doesn't move it, Brief 45 PR F).
    db.$queryRaw<{ rankedAt: Date | null }[]>`SELECT ${rankingTimesSql(organizationId)}`,
    listFolders(organizationId, db),
    listLists(organizationId, {}, db),
    db.callList.count({ where: { organizationId, archivedAt: { not: null } } }),
    listGroups(organizationId, db),
    listWorkflows(organizationId, db),
  ])
  return {
    allLeads: { count, rankedAt: synced?.rankedAt?.toISOString() ?? null },
    folders,
    lists,
    archivedCount,
    groups,
    workflows,
  }
}
