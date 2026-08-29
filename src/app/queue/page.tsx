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
    <main>
      <div className="mx-auto max-w-4xl px-4 py-6">
        <h1 className="mb-4 text-lg font-semibold">Call Queue (preview)</h1>
        <div className="mb-4 flex flex-wrap gap-2">
          {views.map((v) => (
            <Link
              key={v.id}
              href={`/queue?viewId=${v.id}`}
              className={`rounded border px-3 py-1 text-sm ${v.id === viewId ? 'border-blue-600 bg-blue-50 text-blue-700' : 'border-neutral-300 text-neutral-600'}`}
            >
              {v.name}
            </Link>
          ))}
          {views.length === 0 && <span className="text-sm text-neutral-400">No saved views yet.</span>}
        </div>

        {error && <div className="rounded bg-red-50 p-3 text-sm text-red-700">{error}</div>}

        {queue && (
          <>
            {queue.stale && (
              <div className="mb-3 rounded bg-amber-50 p-3 text-sm text-amber-800">
                Stale: {queue.staleReason}
              </div>
            )}
            <p className="mb-3 text-sm text-neutral-500">
              {queue.leads.length} callable · {queue.excludedNoPhone} no-phone · {queue.excludedCompliance} compliance-excluded
            </p>
            <div className="overflow-hidden rounded-lg border border-neutral-200">
              <table className="w-full text-sm">
                <thead className="bg-neutral-50 text-left text-xs uppercase text-neutral-500">
                  <tr>
                    <th className="px-4 py-2">Lead</th>
                    <th className="px-4 py-2">Phone (E.164)</th>
                    <th className="px-4 py-2">Priority</th>
                    <th className="px-4 py-2">Capture</th>
                  </tr>
                </thead>
                <tbody>
                  {queue.leads.map((l) => (
                    <tr key={l.leadId} className="border-t border-neutral-100">
                      <td className="px-4 py-2">
                        <Link href={`/leads/${l.leadId}`} className="text-blue-700 hover:underline">{l.displayName}</Link>
                      </td>
                      <td className="px-4 py-2 font-mono">{l.primaryPhoneE164}</td>
                      <td className="px-4 py-2">{l.ammunition.priorityScore ?? '—'}</td>
                      <td className="px-4 py-2">{l.ammunition.captureStatus ?? '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        )}
      </div>
    </main>
  )
}
