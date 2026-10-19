// Brief 45 PR G — "our value and range" (Brief 44's estimate of the home) on
// Ryan's list pages and Pipeline, in the lead page card's words: "$1.83M",
// "likely $1.54M–$2.12M", "DealFlow estimate · only you see this". Ryan's own
// screens only: our value estimates never reach anything a buyer or homeowner
// sees [Ryan, 2026-10-17], so nothing here goes into a CSV export or a
// message [engineering precaution: exports can be forwarded]. Display only.
import { CircleDollarSign } from 'lucide-react'
import { Tooltip } from '@/components/ui'
import { compactMoney } from '@/lib/core-data/dealflow-sync/property'
import type { OurValueDTO } from '@/lib/core-data/lists/types'

/** The lead page card's label (PropertyValueCard). */
export const OUR_VALUE_LABEL = 'DealFlow estimate · only you see this'
/** No lead of the org has an estimate yet: they come with DealFlow's 7:00 update. */
export const VALUES_LATER = "Values appear after DealFlow's morning update."
/** Estimates are in, but not for anyone on this page (5+ unit buildings, say, get none). */
export const NO_VALUES_HERE = 'No DealFlow estimates for anyone on this page.'

/** "$1.83M" and "likely $1.54M–$2.12M". */
export function ourValueParts(v: OurValueDTO): { value: string; range: string } {
  return { value: compactMoney(v.value), range: `likely ${compactMoney(v.low)}–${compactMoney(v.high)}` }
}

/** A table cell: the value, the range under it; a dash without one. */
export function OurValueCell({ value }: { value: OurValueDTO | null }) {
  if (!value) return <span className="text-subtle">—</span>
  const p = ourValueParts(value)
  return (
    <Tooltip content={OUR_VALUE_LABEL}>
      <span className="flex flex-col whitespace-nowrap">
        <span className="tabular-nums text-fg">{p.value}</span>
        <span className="text-xs tabular-nums text-muted">{p.range}</span>
      </span>
    </Tooltip>
  )
}

/** A Pipeline card's line: "$1.83M · likely $1.54M–$2.12M". */
export function OurValueLine({ value }: { value: OurValueDTO }) {
  const p = ourValueParts(value)
  return (
    <p className="flex min-w-0 items-center gap-1.5" title={OUR_VALUE_LABEL}>
      <CircleDollarSign size={12} className="shrink-0 text-subtle" aria-hidden />
      <span className="shrink-0 tabular-nums">{p.value}</span>
      <span className="truncate text-muted">{`· ${p.range}`}</span>
      <span className="sr-only">{` (${OUR_VALUE_LABEL})`}</span>
    </p>
  )
}

/**
 * The note under a list page's title: whose numbers the "Our value" column
 * shows, or why there is no column ("say what is not there"). Nothing for an
 * empty page: its empty state speaks.
 */
export function valuesNote(opts: { rows: { value: OurValueDTO | null }[]; hasValues: boolean }): string | null {
  if (opts.rows.length === 0) return null
  if (opts.rows.some((r) => r.value)) return `Our value: ${OUR_VALUE_LABEL}`
  return opts.hasValues ? NO_VALUES_HERE : VALUES_LATER
}
