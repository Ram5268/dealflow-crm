import { Suspense } from 'react'
import { getCurrentOrgId } from '@/lib/shell/orgContext'
import {
  CallsTodayCard,
  DialQueueCard,
  PanelSkeleton,
  RepliesTodayCard,
  TasksDueCard,
} from '@/components/focus/FocusPanels'
import {
  NeedsAttentionList,
  NeedsAttentionSkeleton,
} from '@/components/focus/NeedsAttentionList'

export const dynamic = 'force-dynamic'

/**
 * Focus — the start-of-day surface. Panels answer "what does today look like",
 * the list beneath answers "what do I touch first".
 *
 * Each panel streams behind its own Suspense boundary. The dial queue runs a
 * full compliance scrub of its candidate pool, so without this it would hold
 * the whole page hostage to the slowest read.
 */
export default async function FocusPage() {
  const organizationId = await getCurrentOrgId()

  return (
    <div className="mx-auto max-w-6xl px-4 py-4">
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <Suspense fallback={<PanelSkeleton />}>
          <DialQueueCard organizationId={organizationId} />
        </Suspense>
        <Suspense fallback={<PanelSkeleton />}>
          <CallsTodayCard organizationId={organizationId} />
        </Suspense>
        <Suspense fallback={<PanelSkeleton />}>
          <RepliesTodayCard organizationId={organizationId} />
        </Suspense>
        <Suspense fallback={<PanelSkeleton />}>
          <TasksDueCard organizationId={organizationId} />
        </Suspense>
      </div>

      <section className="mt-4 overflow-hidden rounded-lg border border-line bg-elevated">
        <header className="flex h-9 items-center border-b border-line px-3">
          <h2 className="text-[12px] font-medium text-muted">Needs attention</h2>
        </header>
        <Suspense fallback={<NeedsAttentionSkeleton />}>
          <NeedsAttentionList organizationId={organizationId} />
        </Suspense>
      </section>
    </div>
  )
}
