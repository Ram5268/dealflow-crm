'use client'

import { useState } from 'react'
import { useToast } from '@/components/ui'
import { selectAllOffer } from './bulk-actions'
import { plainError } from './group-chips-state'

const num = (n: number) => n.toLocaleString('en-US')

// Brief 45 PR C — "Select all N matching": once every row on the page is
// selected, offer everyone who matches the search and filters, beyond this
// page (the members / all-leads `ids=1` call, at most 25,000 at once), so a
// bulk action can reach all of them [brief §5.4]. Then "Clear selection".
export function SelectAllMatching({
  pageIds,
  selected,
  total,
  onSelect,
  loadAll,
}: {
  pageIds: readonly string[]
  selected: ReadonlySet<string>
  /** Everyone matching the search and filters. */
  total: number
  onSelect(next: Set<string>): void
  /** Every matching id, in rank order. */
  loadAll(): Promise<string[]>
}) {
  const { toast } = useToast()
  const [loading, setLoading] = useState(false)
  const offer = selectAllOffer({ pageIds, selected, total })
  if (offer.kind === 'none') return null

  const selectAll = async () => {
    setLoading(true)
    try {
      onSelect(new Set(await loadAll()))
    } catch (err) {
      toast({ tone: 'danger', title: "Couldn't select everyone", description: plainError(err).message })
    } finally {
      setLoading(false)
    }
  }

  return (
    <div
      data-testid="select-all-matching"
      className="flex shrink-0 flex-wrap items-center justify-center gap-x-2 gap-y-1 border-b border-line bg-accent-subtle px-4 py-1.5 text-sm text-fg"
    >
      {offer.kind === 'offer' ? (
        <>
          <span>All {num(offer.pageCount)} on this page are selected.</span>
          <button
            type="button"
            onClick={selectAll}
            disabled={loading}
            className="font-medium text-link hover:underline disabled:opacity-50"
          >
            {loading ? `Selecting all ${num(offer.total)}…` : `Select all ${num(offer.total)} matching`}
          </button>
        </>
      ) : (
        <>
          <span>
            {offer.capped
              ? `The first ${num(offer.count)} matching are selected (the most at once).`
              : `All ${num(offer.count)} matching are selected.`}
          </span>
          <button type="button" onClick={() => onSelect(new Set())} className="font-medium text-link hover:underline">
            Clear selection
          </button>
        </>
      )}
    </div>
  )
}
