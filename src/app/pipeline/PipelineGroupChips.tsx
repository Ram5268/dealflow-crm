'use client'

import { createContext, useContext } from 'react'
import { GroupChips } from '@/components/lists/GroupChips'
import { CRM_CHIP_API, type ChipApi } from '@/components/lists/group-chips-state'
import { useSidebarData } from '@/lib/core-data/lists/client'
import type { GroupChipDTO } from '@/lib/core-data/lists/types'
import type { PersonQueue } from './move-queue'
import { GroupBadges } from './GroupBadges'

/**
 * How the Pipeline's chips reach the CRM: through the page's per-person
 * queue (move-queue.ts), so a chip click or 1–9 and a card move of the same
 * person go one after the other. Without a provider: PR A's routes directly.
 */
export const PipelineChipApi = createContext<ChipApi | undefined>(undefined)

/** PR C's chip requests, each waiting in that person's line on the Pipeline. */
export function queuedChipApi(people: PersonQueue, api: ChipApi = CRM_CHIP_API): ChipApi {
  return {
    add: (groupId, leadId) => people.run(leadId, () => api.add(groupId, leadId)),
    remove: (groupId, leadId) => people.run(leadId, () => api.remove(groupId, leadId)),
    // "+" makes a new group: nothing on the board can be moving into or out of it yet.
    create: (input) => api.create(input),
  }
}

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
  const api = useContext(PipelineChipApi)
  if (!sidebar.data) {
    return (
      // A click here (a moment before the chips are ready) mustn't open a table row.
      <span className="contents" onClick={(e) => e.stopPropagation()}>
        <GroupBadges groups={groups} />
      </span>
    )
  }
  return <GroupChips leadId={leadId} memberOf={groups.map((g) => g.id)} compact hotkeys api={api} />
}
