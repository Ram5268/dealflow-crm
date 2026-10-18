'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import type { LeadMemberships } from '@/lib/core-data/lists/types'
import { GroupChips } from './GroupChips'
import { LeadListChips } from './LeadListChips'

// Brief 45 PR C — the lead page header's "Groups:" and "Lists:" rows
// [brief §5.3]. After a chip change the page refreshes, so the timeline shows
// the new "Added to …" / "Removed from …" entry at once.
//
// The chips keep their own state once shown: the refresh's copy of the groups
// is not fed back into them, so a refresh that started before a later click
// reached the CRM can never flicker that chip back. Keyed by lead in the page.
export function LeadMembershipRows({
  leadId,
  groupIds,
  lists,
}: {
  leadId: string
  groupIds: LeadMemberships['groupIds']
  lists: LeadMemberships['lists']
}) {
  const router = useRouter()
  const [memberOf] = useState(groupIds)
  return (
    <div className="mt-2 flex flex-col gap-1.5">
      <GroupChips leadId={leadId} memberOf={memberOf} hotkeys onChange={() => router.refresh()} />
      <LeadListChips lists={lists} />
    </div>
  )
}
