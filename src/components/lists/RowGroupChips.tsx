'use client'

import { useState } from 'react'
import { Check } from 'lucide-react'
import { useSidebarData } from '@/lib/core-data/lists/client'
import type { GroupChipDTO } from '@/lib/core-data/lists/types'
import { GroupChips, chipClassName } from './GroupChips'

// Brief 45 PR C — the group chips on one row of a list page (compact): every
// group as a chip, one click on, one click off, keys 1–9 while the row has
// focus [brief §5.3]. Their row shows their group chips [brief §5.1 rule 2].
//
// The row's groups are frozen once shown: the chips own them from then on,
// and a later reload of the page isn't fed back in, so a reload that started
// before a click reached the CRM can never flip that chip back [engineering
// precaution, from the PR C review]. The page gives the row's chips a new key
// after a bulk change, so those show. Key this component by lead.
export function RowGroupChips({ leadId, groups }: { leadId: string; groups: GroupChipDTO[] }) {
  const sidebar = useSidebarData()
  const [memberOf] = useState(() => groups.map((g) => g.id))
  // Until every group's name is loaded (and on the server), show the row's own
  // groups as they are, so 100 rows don't all say "Loading groups…". The same if
  // they couldn't load: the sidebar says so once, rather than every row.
  if (!sidebar.data) return <RowGroupsAsLoaded groups={groups} />
  return <GroupChips leadId={leadId} memberOf={memberOf} compact hotkeys />
}

function RowGroupsAsLoaded({ groups }: { groups: GroupChipDTO[] }) {
  if (groups.length === 0) return <span className="text-subtle">—</span>
  return (
    // A click here (a moment before the chips are ready) mustn't open the row.
    <span className="flex flex-wrap gap-1" onClick={(e) => e.stopPropagation()}>
      {groups.map((g) => (
        <span key={g.id} className={chipClassName(g.color, true, true)}>
          <Check size={10} aria-hidden="true" className="shrink-0" />
          <span className="min-w-0 max-w-[9rem] truncate">{g.name}</span>
        </span>
      ))}
    </span>
  )
}
