import { prisma } from '@/lib/prisma'
import { dialingEnabled } from '@/lib/telephony/dialingSwitch'

// Brief 37 — on /queue, the dialer and lead pages while calling is off. "rankings
// use test buyers" only when DealFlow's latest run used them (stored per signal).
export async function CallingOffBanner({ organizationId }: { organizationId: string }) {
  if (dialingEnabled()) return null
  const latest = await prisma.dealFlowDerivedSignal.findFirst({
    where: { organizationId },
    orderBy: { syncedAt: 'desc' },
    select: { dealflowRawJson: true },
  })
  const raw = latest?.dealflowRawJson as { includeTestBuyers?: unknown } | null | undefined
  return (
    <div role="status" className="rounded-md bg-warning-subtle p-3 text-base font-medium text-warning">
      {raw?.includeTestBuyers === true ? 'Calling is off — rankings use test buyers' : 'Calling is off'}
    </div>
  )
}
