// Brief 45 — what stays picked on a list page when its rows reload.
//
// A refresh of the same view (the sidebar or a group chip changed something:
// crm:lists-changed → router.refresh) keeps everyone still on the page picked,
// so a selection survives the clicks people make while working through it. A
// new search, filter or page starts with nothing picked. Pure: ListView calls
// it from an effect; the tests call it directly.

/**
 * @param picked      the lead ids picked before the reload
 * @param rows        the rows on the page now
 * @param viewChanged the search, a filter or the page number changed
 * @returns the same Set when nothing changes (no needless re-render)
 */
export function keepSelection(picked: ReadonlySet<string>, rows: readonly { leadId: string }[], viewChanged: boolean): Set<string> {
  if (viewChanged) return picked.size === 0 ? (picked as Set<string>) : new Set()
  const onPage = new Set(rows.map((r) => r.leadId))
  const kept = [...picked].filter((id) => onPage.has(id))
  return kept.length === picked.size ? (picked as Set<string>) : new Set(kept)
}
