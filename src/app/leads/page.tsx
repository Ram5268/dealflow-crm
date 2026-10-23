import { Suspense } from 'react'
import { NewLeadModal } from './NewLeadModal'
import { prisma } from '@/lib/prisma'
import { getCurrentOrgId } from '@/lib/shell/orgContext'
import { isLeadSortKey, listLeads } from '@/lib/leads/list'
import { loadUploads } from '@/lib/core-data/leads/uploads'
import { pageParam } from '@/lib/ui/pageParam'
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
  // Brief 45: 1 to MAX_PAGE, else 1, so a huge ?page= never reaches the query.
  const page = pageParam(sp.page)

  const [result, views] = await Promise.all([
    listLeads({ organizationId, q: sp.q, viewId: sp.viewId, sortKey, sortDir, page, group: sp.group }),
    prisma.savedView.findMany({
      where: { organizationId, type: 'lead' },
      orderBy: { updatedAt: 'desc' },
      select: { id: true, name: true },
    }),
  ])
  // Brief 50 PR 14: the uploads this page's leads came from, so Source reads
  // "Mojo Export" instead of "import:<id>". One small query.
  const uploads = await loadUploads(organizationId, result.rows.map((r) => r.source))

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
        viewNote={result.viewNote}
        // Brief 41.2 (PR E): the switches are server settings, so the reason is decided here.
        sequencesOffReason={sequencesOffReason()}
        group={result.group ?? null}
        groupError={result.groupError}
        rankedAt={result.rankedAt ?? null}
        uploads={uploads}
      />
    </>
  )
}
