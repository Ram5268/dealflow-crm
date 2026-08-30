import { getCurrentOrgId } from '@/lib/shell/orgContext'
import { getThread, listThreads } from '@/lib/inbox/threads'
import { isInboxFilter, type InboxFilter } from '@/lib/inbox/types'
import { InboxView } from './InboxView'

export const dynamic = 'force-dynamic'

/**
 * Unified inbox. The URL is the source of truth for both the filter tab and the
 * open thread, which keeps back/forward working and lets the detail pane be a
 * server read — §13 forbids new API routes, so there is nothing to fetch from.
 *
 * The filter is ALSO mirrored to localStorage by the client so the choice
 * survives a fresh visit to a bare /inbox.
 */
export default async function InboxPage({
  searchParams,
}: {
  searchParams: Promise<{ filter?: string; thread?: string }>
}) {
  const organizationId = await getCurrentOrgId()
  const { filter: rawFilter, thread } = await searchParams
  const filter: InboxFilter = isInboxFilter(rawFilter) ? rawFilter : 'all'

  const [{ threads, truncated }, detail] = await Promise.all([
    listThreads(organizationId, filter),
    thread ? getThread(organizationId, thread) : Promise.resolve(null),
  ])

  return <InboxView threads={threads} detail={detail} filter={filter} truncated={truncated} />
}
