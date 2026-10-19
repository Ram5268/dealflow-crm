import { prisma } from '@/lib/prisma'
import { dialingEnabled } from '@/lib/telephony/dialingSwitch'
import { morningSignal } from '@/lib/core-data/lists/sql'

// Brief 37 — on /queue, the dialer and lead pages while calling is off. "rankings
// use test buyers" only when DealFlow's latest run used them (stored per signal).
// Brief 45 PR F: "latest run" is the morning sync's newest signal, not a row an
// upload's scoring wrote later in the day (lists/sql.ts morningSignal)
// [engineering precaution].
export async function CallingOffBanner({ organizationId }: { organizationId: string }) {
  if (dialingEnabled()) return null
  const [latest] = await prisma.$queryRaw<{ includeTestBuyers: unknown }[]>`
    SELECT s."dealflowRawJson"->'includeTestBuyers' AS "includeTestBuyers"
    FROM "DealFlowDerivedSignal" s
    WHERE s."organizationId" = ${organizationId} AND ${morningSignal('s')}
    ORDER BY s."syncedAt" DESC
    LIMIT 1`
  return (
    <div role="status" className="rounded-md bg-warning-subtle p-3 text-base font-medium text-warning">
      {latest?.includeTestBuyers === true ? 'Calling is off — rankings use test buyers' : 'Calling is off'}
    </div>
  )
}
