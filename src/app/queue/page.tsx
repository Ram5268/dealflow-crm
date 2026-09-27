import Link from 'next/link'
import { prisma } from '@/lib/prisma'
import { getCurrentOrgId } from '@/lib/shell/orgContext'
import { getQueue } from '@/lib/core-data/smart-view/queue-service'
import { getReviewList } from '@/lib/core-data/smart-view/review-list'
import { DEFAULT_VIEW_ID } from '@/lib/core-data/smart-view/defaultView'
import { dialingEnabled } from '@/lib/telephony/dialingSwitch'
import { CallingOffBanner } from '@/components/CallingOffBanner'

export const dynamic = 'force-dynamic'

const TH = 'h-[41px] border-b border-r border-line px-3 font-bold text-fg last:border-r-0'
const TD = 'border-r border-line px-3 last:border-r-0'
const REVIEW_COLUMNS = ['#', 'Lead', 'Address', 'Priority', 'Top match', 'Why', 'DealFlow']

// Read-only queue preview (Agent B owns the real dialer UI). Opens the
// "DealFlow priority" view by default (Brief 37).
//  - Calling ON: the ranked, pre-scrubbed callable list with exclusion counts +
//    stale banner (getQueue, unchanged). primaryPhoneE164.
//  - Calling OFF: the review list — the view's ranked leads without the
//    callable-now scrub. No phone column and no call/text/email actions; rows
//    link to the lead page and to DealFlow only.
export default async function QueuePage({ searchParams }: { searchParams: Promise<{ viewId?: string }> }) {
  const organizationId = await getCurrentOrgId()
  const { viewId: requested } = await searchParams
  const views = await prisma.savedView.findMany({ where: { organizationId, type: 'lead' }, orderBy: { updatedAt: 'desc' } })
  const viewId = requested ?? (views.some((v) => v.id === DEFAULT_VIEW_ID) ? DEFAULT_VIEW_ID : undefined)
  const reviewMode = !dialingEnabled()

  let queue: Awaited<ReturnType<typeof getQueue>> | null = null
  let review: Awaited<ReturnType<typeof getReviewList>> | null = null
  let error: string | null = null
  if (viewId) {
    try {
      if (reviewMode) review = await getReviewList(viewId, organizationId)
      else queue = await getQueue(viewId, organizationId, { limit: 50 })
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
            {reviewMode
              ? 'Ranked by DealFlow. Review only — nothing here can place a call.'
              : 'Read-only preview of the ranked, pre-scrubbed callable list.'}
          </p>
        </header>
        {reviewMode && (
          <div className="mb-4">
            <CallingOffBanner organizationId={organizationId} />
          </div>
        )}
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

        {review && (
          <>
            <p className="mb-3 text-base text-muted">
              {review.total} ranked lead{review.total === 1 ? '' : 's'}
              {review.total > review.leads.length && ` · showing the top ${review.leads.length}`}
            </p>
            <div className="overflow-x-auto border-b border-line">
              <table className="w-full border-collapse text-base">
                <thead className="bg-bg text-left">
                  <tr>
                    {REVIEW_COLUMNS.map((c) => <th key={c} className={TH}>{c}</th>)}
                  </tr>
                </thead>
                <tbody>
                  {review.leads.map((l, i) => (
                    <tr key={l.leadId} className="h-10 border-b border-line">
                      <td className={`${TD} text-muted`}>{i + 1}</td>
                      <td className={TD}>
                        <Link href={`/leads/${l.leadId}`} className="text-link hover:underline">{l.displayName}</Link>
                      </td>
                      <td className={TD}>{l.primaryAddressSummary ?? '—'}</td>
                      <td className={TD}>{l.priorityScore ?? '—'}</td>
                      <td className={TD}>{l.topMatchFit ?? '—'}</td>
                      <td className={TD}>{l.matchReason ?? '—'}</td>
                      <td className={TD}>
                        {l.dealflowDeepLink ? (
                          <a href={l.dealflowDeepLink} target="_blank" rel="noreferrer" className="text-link hover:underline">
                            Open
                          </a>
                        ) : (
                          '—'
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        )}

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
