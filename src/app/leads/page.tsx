import { prisma } from '@/lib/prisma'
import { getCurrentOrgId } from '@/lib/shell/orgContext'
import { isLeadSortKey, listLeads } from '@/lib/leads/list'
import { LeadsView } from './LeadsView'

export const dynamic = 'force-dynamic'

type Search = {
  q?: string
  viewId?: string
  sort?: string
  dir?: string
  page?: string
}

export default async function LeadsPage({
  searchParams,
}: {
  searchParams: Promise<Search>
}) {
  const organizationId = await getCurrentOrgId()
  const sp = await searchParams

  const sortKey = isLeadSortKey(sp.sort) ? sp.sort : 'updatedAt'
  const sortDir = sp.dir === 'asc' ? 'asc' : 'desc'
  const page = Math.max(1, Number(sp.page) || 1)

  const [result, views] = await Promise.all([
    listLeads({ organizationId, q: sp.q, viewId: sp.viewId, sortKey, sortDir, page }),
    prisma.savedView.findMany({
      where: { organizationId, type: 'lead' },
      orderBy: { updatedAt: 'desc' },
      select: { id: true, name: true },
    }),
  ])

  return (
    <LeadsView
      rows={result.rows}
      total={result.total}
      page={result.page}
      pageSize={result.pageSize}
      sortKey={sortKey}
      sortDir={sortDir}
      q={sp.q ?? ''}
      viewId={sp.viewId ?? ''}
      views={views}
      viewError={result.viewError}
    />
  )
}
