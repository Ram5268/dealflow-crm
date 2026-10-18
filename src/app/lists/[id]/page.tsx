import { getCurrentOrgId } from '@/lib/shell/orgContext'
import { HttpError } from '@/lib/shared/http'
import { getRankedPage } from '@/lib/core-data/lists/ranked'
import { listGroups } from '@/lib/core-data/lists/groups'
import { dialingEnabled } from '@/lib/telephony/dialingSwitch'
import { ListNotFound, ListView } from './ListView'
import { parseListSearch, type ListSearch } from './filters'

export const dynamic = 'force-dynamic'

// Brief 45 — a list's page: its people in today's rank order, 100 a page,
// with each person's rank in the whole list whatever the filters (brief §5.4).
// Reads only. The calling switch is read, never changed (Brief 37); while it
// is off "Start calling this list" and the "called today" filter are greyed
// out with the reason.
export default async function ListPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>
  searchParams: Promise<ListSearch>
}) {
  const [{ id }, sp, organizationId] = await Promise.all([params, searchParams, getCurrentOrgId()])
  const { page, filters } = parseListSearch(sp, { callingOn: dialingEnabled() })

  let data: Awaited<ReturnType<typeof getRankedPage>>
  let groups: Awaited<ReturnType<typeof listGroups>>
  try {
    ;[data, groups] = await Promise.all([getRankedPage(organizationId, id, { page, filters }), listGroups(organizationId)])
  } catch (err) {
    if (err instanceof HttpError && err.status === 404) return <ListNotFound />
    throw err
  }

  return <ListView data={data} groups={groups.map((g) => ({ id: g.id, name: g.name, color: g.color }))} filters={filters} />
}
