import type { GroupChipDTO } from '@/lib/core-data/lists/types'
import { cn } from '@/lib/ui/cn'
import { groupColorStyle } from '@/lib/ui/groupColors'

/**
 * A card's or row's groups, read-only, in sidebar order, each with its color
 * (PR B's tokens, both themes). Shown until the groups have loaded and the
 * clickable chips take over (PipelineGroupChips), and on the server.
 */
export function GroupBadges({ groups }: { groups: GroupChipDTO[] }) {
  return (
    <>
      {groups.map((g) => (
        <span
          key={g.id}
          data-group-id={g.id}
          className="inline-flex h-5 max-w-full items-center gap-1 truncate rounded-full bg-active px-2 text-xs font-medium text-fg"
        >
          <span aria-hidden="true" className={cn('h-1.5 w-1.5 shrink-0 rounded-full', groupColorStyle(g.color).dot)} />
          {g.name}
        </span>
      ))}
    </>
  )
}
