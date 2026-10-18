import { Suspense } from 'react'
import { NewLeadModal } from './NewLeadModal'
import { prisma } from '@/lib/prisma'
import { getCurrentOrgId } from '@/lib/shell/orgContext'
import { isLeadSortKey, listLeads } from '@/lib/leads/list'
import { sequencesOffReason } from '@/lib/comms/sequences/channel-gate'
import { LeadsView } from './LeadsView'

export const dynamic = 'force-dynamic'

type Search = {
  q?: string
  viewId?: string
  sort?: string
  dir?: string
  page?: string
  /** Brief 45: a group's id (the sidebar's group links), or 'none'. */
  group?: string
}

export default async function LeadsPage({
  searchParams,
}: {
  searchParams: Promise<Search>
}) {
  const organizationId = await getCurrentOrgId()
  const sp = await searchParams

  // A column only when the URL names one; otherwise listLeads picks the
  // default (a Smart View's own saved sort, or, Brief 45, the lists' rank order).
  const sortKey = isLeadSortKey(sp.sort) ? sp.sort : undefined
  const sortDir = sp.dir === 'asc' ? 'asc' : 'desc'
  const page = Math.max(1, Number(sp.page) || 1)

  const [result, views] = await Promise.all([
    listLeads({ organizationId, q: sp.q, viewId: sp.viewId, sortKey, sortDir, page, group: sp.group }),
    prisma.savedView.findMany({
      where: { organizationId, type: 'lead' },
      orderBy: { updatedAt: 'desc' },
      select: { id: true, name: true },
    }),
  ])

  return (
    <>
      {/* Opened by ?new=1 — the destination the top bar and ⌘K already linked
          to (M6). Suspense because it reads useSearchParams. */}
      <Suspense fallback={null}>
        <NewLeadModal />
      </Suspense>
      <LeadsView
        rows={result.rows}
        total={result.total}
        page={result.page}
        pageSize={result.pageSize}
        sort={result.sort}
        q={sp.q ?? ''}
        viewId={sp.viewId ?? ''}
        views={views}
        viewError={result.viewError}
        // Brief 41.2 (PR E): the switches are server settings, so the reason is decided here.
        sequencesOffReason={sequencesOffReason()}
        group={result.group ?? null}
        groupError={result.groupError}
        rankedAt={result.rankedAt ?? null}
      />
    </>
  )
}
