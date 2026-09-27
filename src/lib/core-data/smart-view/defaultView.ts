import type { SQuery, SortSpec } from '@/lib/core-data/query-dsl/schema'

// Brief 37 — the "DealFlow priority" lead view. It takes the id the dialer
// already asks for (save_default), so /queue, the dialer and the Focus card open
// it by default. The sync creates it when missing and never overwrites it.

export const DEFAULT_VIEW_ID = 'save_default'

// Leads DealFlow ranked. The DSL has no "is set" test; scores run 0-100 and
// `NULL >= 0` is never true in SQL, so this keeps exactly the ranked leads.
export const HAS_DEALFLOW_PRIORITY: SQuery = {
  type: 'field_condition',
  field: { kind: 'regular', table: 'lead', column: 'priorityScore' },
  condition: { type: 'number', op: 'gte', value: 0 },
}

export const DEFAULT_VIEW = {
  id: DEFAULT_VIEW_ID,
  name: 'DealFlow priority',
  description: 'Sellers DealFlow ranked overnight, best first. Created by the DealFlow sync.',
  sQuery: HAS_DEALFLOW_PRIORITY,
  sort: [
    { field: 'priorityScore', direction: 'desc' },
    { field: 'topMatchFit', direction: 'desc' },
  ] as SortSpec,
}
