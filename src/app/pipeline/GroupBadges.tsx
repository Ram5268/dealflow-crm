import type { GroupChipDTO } from '@/lib/core-data/lists/types'

/**
 * A card's or row's groups, read-only, in sidebar order.
 *
 * Integration seam (Brief 45 PR C): once PR C merges, these labels become
 * `<GroupChips compact leadId memberOf onChange>` (CONTRACT §8), so a click
 * on a card adds or removes a group. Group colors come with PR B's tokens.
 */
export function GroupBadges({ groups }: { groups: GroupChipDTO[] }) {
  return (
    <>
      {groups.map((g) => (
        <span
          key={g.id}
          data-group-id={g.id}
          className="inline-flex h-5 max-w-full items-center truncate rounded-full bg-active px-2 text-xs font-medium text-fg"
        >
          {g.name}
        </span>
      ))}
    </>
  )
}
