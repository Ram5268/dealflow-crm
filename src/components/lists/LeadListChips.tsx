import Link from 'next/link'
import type { LeadMemberships } from '@/lib/core-data/lists/types'

// Brief 45 PR C — the "Lists:" row on the lead page [brief §5.3]: one chip
// per active list the lead is on (sidebar order, from
// /api/core-data/leads/[id]/memberships), each linking to that list. One
// person is one lead, so the same record shows here whatever list it came
// from [Ryan, 2026-10-18].
export function LeadListChips({ lists }: { lists: LeadMemberships['lists'] }) {
  return (
    <div data-testid="lead-list-chips" className="flex min-w-0 flex-wrap items-center gap-1.5">
      <span className="mr-0.5 text-sm text-subtle">Lists:</span>
      {lists.length === 0 ? (
        <span className="text-sm text-subtle">Not on any list yet</span>
      ) : (
        lists.map((l) => (
          <Link
            key={l.id}
            href={`/lists/${encodeURIComponent(l.id)}`}
            title={l.folderName ? `In the folder ${l.folderName}` : 'Not in a folder'}
            className="inline-flex h-6 min-w-0 max-w-full items-center rounded-full border border-line bg-elevated px-2 text-sm text-link transition-colors duration-100 hover:bg-hover hover:underline"
          >
            <span className="min-w-0 max-w-[16rem] truncate">{l.name}</span>
          </Link>
        ))
      )}
    </div>
  )
}
