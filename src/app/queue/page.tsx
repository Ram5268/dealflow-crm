import Link from 'next/link'
import { prisma } from '@/lib/prisma'
import { getCurrentOrgId } from '@/lib/shell/orgContext'
import { getQueue } from '@/lib/core-data/smart-view/queue-service'

export const dynamic = 'force-dynamic'

// Read-only queue preview (Agent B owns the real dialer UI). Shows the ranked,
// pre-scrubbed callable list with exclusion counts + stale banner. primaryPhoneE164.
export default async function QueuePage({ searchParams }: { searchParams: Promise<{ viewId?: string }> }) {
  const organizationId = await getCurrentOrgId()
  const { viewId } = await searchParams
  const views = await prisma.savedView.findMany({ where: { organizationId, type: 'lead' }, orderBy: { updatedAt: 'desc' } })

  let queue: Awaited<ReturnType<typeof getQueue>> | null = null
  let error: string | null = null
  if (viewId) {
    try {
      queue = await getQueue(viewId, organizationId, { limit: 50 })
    } catch (e) {
      error = e instanceof Error ? e.message : 'Failed to load queue'
    }
  }

  return (
    <div>
      <div className="px-4 py-4">
        {/* AppShell's top bar already renders this page's title, so the page
            contributes a heading, not a second <h1>. */}
        <header className="mb-4">
          <h2 className="text-3xl font-bold text-fg">Call Queue</h2>
          <p className="mt-1 text-base text-muted">
            Read-only preview of the ranked, pre-scrubbed callable list.
          </p>
        </header>
        <div className="mb-4 flex flex-wrap gap-1">
          {views.map((v) => (
            <Link
              key={v.id}
              href={`/queue?viewId=${v.id}`}
              className={`flex h-6 items-center rounded-md px-2 text-sm font-normal transition-colors ${v.id === viewId ? 'bg-line text-fg' : 'text-muted hover:bg-hover hover:text-fg'}`}
            >
              {v.name}
            </Link>
          ))}
          {views.length === 0 && <span className="text-sm text-subtle">No saved views yet.</span>}
        </div>

        {error && <div className="rounded-md bg-danger-subtle p-3 text-base text-danger">{error}</div>}

        {queue && (
          <>
            {queue.stale && (
              <div className="mb-3 rounded-md bg-warning-subtle p-3 text-base text-warning">
                Stale: {queue.staleReason}
              </div>
            )}
            <p className="mb-3 text-base text-muted">
              {queue.leads.length} callable · {queue.excludedNoPhone} no-phone · {queue.excludedCompliance} compliance-excluded
            </p>
            <div className="overflow-x-auto border-b border-line">
              <table className="w-full border-collapse text-base">
                <thead className="bg-bg text-left">
                  <tr>
                    <th className="h-[41px] border-b border-r border-line px-3 font-bold text-fg last:border-r-0">Lead</th>
                    <th className="h-[41px] border-b border-r border-line px-3 font-bold text-fg last:border-r-0">Phone (E.164)</th>
                    <th className="h-[41px] border-b border-r border-line px-3 font-bold text-fg last:border-r-0">Priority</th>
                    <th className="h-[41px] border-b border-r border-line px-3 font-bold text-fg last:border-r-0">Capture</th>
                  </tr>
                </thead>
                <tbody>
                  {queue.leads.map((l) => (
                    <tr key={l.leadId} className="h-10 border-b border-line">
                      <td className="border-r border-line px-3 last:border-r-0">
                        <Link href={`/leads/${l.leadId}`} className="text-link hover:underline">{l.displayName}</Link>
                      </td>
                      <td className="border-r border-line px-3 font-mono last:border-r-0">{l.primaryPhoneE164}</td>
                      <td className="border-r border-line px-3 last:border-r-0">{l.ammunition.priorityScore ?? '—'}</td>
                      <td className="border-r border-line px-3 last:border-r-0">{l.ammunition.captureStatus ?? '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        )}
      </div>
    </div>
  )
}
