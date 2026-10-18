'use client'

import { useEffect, useState } from 'react'
import { Skeleton } from '@/components/ui'
import { getLeadMemberships } from '@/lib/core-data/lists/client'
import { GroupChips } from './GroupChips'
import { plainError } from './group-chips-state'

// Brief 45 PR C — group chips for a card that knows only the lead's id (the
// dialer's Ammunition card): loads the lead's groups from
// /api/core-data/leads/[id]/memberships, then shows the same chips as the
// lead page [brief §5.3].
export function LeadGroupChips({ leadId, hotkeys = false }: { leadId: string; hotkeys?: boolean }) {
  const [loaded, setLoaded] = useState<{ leadId: string; groupIds: string[] | null; error: string | null } | null>(null)

  useEffect(() => {
    let cancelled = false
    getLeadMemberships(leadId).then(
      (m) => !cancelled && setLoaded({ leadId, groupIds: m.groupIds, error: null }),
      (err: unknown) => !cancelled && setLoaded({ leadId, groupIds: null, error: plainError(err).message }),
    )
    return () => {
      cancelled = true
    }
  }, [leadId])

  if (!loaded || loaded.leadId !== leadId) return <Skeleton className="h-6 w-48" />
  if (!loaded.groupIds) {
    return <p className="text-sm text-danger">This person&apos;s groups couldn&apos;t load: {loaded.error}</p>
  }
  return <GroupChips key={leadId} leadId={leadId} memberOf={loaded.groupIds} hotkeys={hotkeys} />
}
