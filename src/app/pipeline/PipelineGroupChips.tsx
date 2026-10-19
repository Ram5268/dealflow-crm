'use client'

import { GroupChips } from '@/components/lists/GroupChips'
import { useSidebarData } from '@/lib/core-data/lists/client'
import type { GroupChipDTO } from '@/lib/core-data/lists/types'
import { GroupBadges } from './GroupBadges'

/**
 * A card's or a table row's group chips (PR C) [brief §5.3]: every group as a
 * chip in sidebar order, one click on, one click off, keys 1–9 while the card
 * or row has focus, and "+" to make a group and add the person.
 *
 * The chips follow the board: a move (drag, [ ], M) changes a person's groups
 * outside them, so they take each new value from the page (PR C's chips keep
 * a click that is still on its way). Until every group has loaded, and on the
 * server, the person's own groups show as read-only labels, so a board of
 * cards doesn't say "Loading groups…" everywhere. The same if the groups
 * couldn't load: the sidebar says so once, rather than every card (as PR C's
 * list rows do).
 */
export function PipelineGroupChips({ leadId, groups }: { leadId: string; groups: GroupChipDTO[] }) {
  const sidebar = useSidebarData()
  if (!sidebar.data) {
    return (
      // A click here (a moment before the chips are ready) mustn't open a table row.
      <span className="contents" onClick={(e) => e.stopPropagation()}>
        <GroupBadges groups={groups} />
      </span>
    )
  }
  return <GroupChips leadId={leadId} memberOf={groups.map((g) => g.id)} compact hotkeys />
}
