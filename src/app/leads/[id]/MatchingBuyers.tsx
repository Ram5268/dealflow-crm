import { ExternalLink } from 'lucide-react'
import { Badge } from '@/components/ui'
import { buyerName, buyerWants, type DealflowBuyer } from '@/lib/core-data/dealflow-sync/buyers'
import { reasonList } from '@/lib/core-data/dealflow-sync/labels'
import { dealflowDeepLink } from '@/lib/core-data/dealflow-sync/sync'

// Brief 38 — the buyers DealFlow matched to this seller, best match first.
// Display only: no phone numbers or emails, and no call, text or email actions.
export function MatchingBuyers({ buyers }: { buyers: DealflowBuyer[] }) {
  if (buyers.length === 0) return <p className="py-2 text-sm text-subtle">No matching buyers yet</p>
  return (
    <ul className="flex flex-col divide-y divide-line">
      {buyers.map((b) => (
        <li key={b.matchId} className="py-2.5 first:pt-0 last:pb-0">
          <div className="flex items-center gap-2">
            <p className="min-w-0 truncate text-sm font-medium text-fg">{buyerName(b)}</p>
            {b.isTestData && <Badge>Test buyer</Badge>}
            {b.score != null && <span className="ml-auto shrink-0 text-sm text-muted">Match {b.score}</span>}
          </div>
          <p className="mt-0.5 text-sm text-fg">{buyerWants(b)}</p>
          {b.reasonKeys.length > 0 && <p className="mt-0.5 text-sm text-muted">{reasonList(b.reasonKeys)}</p>}
          <a
            href={dealflowDeepLink(b.matchId) ?? undefined}
            target="_blank"
            rel="noreferrer"
            className="mt-1 inline-flex items-center gap-1 text-sm text-accent hover:underline"
          >
            Open in DealFlow
            <ExternalLink size={12} />
          </a>
        </li>
      ))}
    </ul>
  )
}
