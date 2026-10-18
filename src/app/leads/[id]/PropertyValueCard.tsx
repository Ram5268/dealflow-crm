import {
  compText,
  dayText,
  factRows,
  noValueText,
  sourcesText,
  valueLine,
  type DealflowProperty,
} from '@/lib/core-data/dealflow-sync/property'

// Brief 44 (PR 5): DealFlow's estimate of this home's value and the public
// facts behind it, from the newest published monthly valuation. Ryan's own
// screen only: our value estimates stay out of anything a buyer or homeowner
// could see (Ryan's decision, 2026-10-17), and the card says so. One value and
// one range, no confidence label, and no buttons or option selections anywhere
// (Ryan's instructions, 2026-10-04). Display only. Everything wraps, so it fits
// a phone; up to 5 nearby sales (both Brief 44 §6).
const SHOWN_SALES = 5

export function PropertyValueCard({ property: p }: { property: DealflowProperty | null }) {
  if (!p) return <p className="py-2 text-sm text-subtle">No value yet</p>
  const value = valueLine(p)
  const sales = value ? p.comps.slice(0, SHOWN_SALES) : []
  const facts = factRows(p.facts)
  const sources = sourcesText(p)
  return (
    <div className="flex flex-col gap-3">
      <div>
        {value ? (
          <>
            <p className="text-lg font-semibold text-fg">{value}</p>
            <p className="text-sm text-muted">{`As of ${dayText(p.asOf)}`}</p>
          </>
        ) : (
          <p className="text-sm text-fg">{noValueText(p.reason)}</p>
        )}
        <p className="mt-0.5 text-xs text-subtle">{value ? 'DealFlow estimate · only you see this' : 'Only you see this'}</p>
      </div>

      {sales.length > 0 && (
        <div>
          <h3 className="text-xs font-medium text-muted">Nearby sales</h3>
          <ul className="mt-1 flex flex-col divide-y divide-line">
            {sales.map((c, i) => (
              <li key={i} className="py-1.5 first:pt-0 last:pb-0">
                <p className="break-words text-sm text-fg">{c.address}</p>
                <p className="text-sm text-muted">{compText(c)}</p>
              </li>
            ))}
          </ul>
        </div>
      )}

      {facts.length > 0 && (
        <div>
          <h3 className="text-xs font-medium text-muted">Facts</h3>
          {/* The lead page's Row look (page.tsx). */}
          <dl className="mt-1">
            {facts.map((f, i) => (
              <div key={i} className="flex gap-3 py-1 text-sm">
                <dt className="w-28 shrink-0 text-subtle">{f.label}</dt>
                <dd className="min-w-0 flex-1 break-words text-fg">{f.value}</dd>
              </div>
            ))}
          </dl>
        </div>
      )}

      {sources && <p className="text-xs text-subtle">{sources}</p>}
    </div>
  )
}
