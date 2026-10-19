import { z } from 'zod'
import { UnavailableFilterError, firstUnavailableFilter, unavailableFilterMessage } from './compliance-filters'

// ─────────────────────────────────────────────────────────────────────────────
// Advanced Filtering DSL — recursive s_query schema (Close-CRM style).
//
// A SavedView stores one of these trees in `sQuery`. The compiler (compiler.ts)
// turns it into parameterized SQL against the Lead base table. The zod schema
// here is the *validation* boundary: anything that reaches the compiler has
// already been shape-checked, so the compiler can assume well-formed input and
// focus on safe SQL emission (identifier allow-listing + $N params).
// ─────────────────────────────────────────────────────────────────────────────

// Which base object a field/condition targets. `lead` is the query root; the
// others compile to correlated EXISTS subqueries against the Lead.
export const objectTypeSchema = z.enum([
  'lead',
  'contact',
  'opportunity',
  'activity',
])
export type DslObjectType = z.infer<typeof objectTypeSchema>

// ── FieldRef ────────────────────────────────────────────────────────────────
export const fieldRefSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('regular'),
    table: z.string(),
    column: z.string(),
  }),
  z.object({
    kind: z.literal('custom'),
    definitionId: z.string(),
  }),
  // Both names stay in the shape so a view saved with either still reads;
  // 'callable_now' is hidden (Brief 50 PR 4, compliance-filters.ts), so
  // sQuerySchema and parseSavedViewQuery refuse it. The condition is ignored.
  z.object({
    kind: z.literal('compliance'),
    predicate: z.enum(['callable_now', 'dnc_clean']),
  }),
])
export type FieldRef = z.infer<typeof fieldRefSchema>

// ── Condition ─────────────────────────────────────────────────────────────────
export const conditionSchema = z.union([
  z.object({
    type: z.literal('text'),
    mode: z.enum(['full_words', 'exact', 'contains']),
    value: z.string(),
  }),
  z.object({
    type: z.literal('number'),
    op: z.enum(['gt', 'lt', 'gte', 'lte', 'eq']),
    value: z.number(),
  }),
  z.object({
    type: z.literal('number'),
    op: z.literal('in'),
    values: z.array(z.number()),
  }),
  z.object({
    type: z.literal('date'),
    op: z.enum(['before', 'after']),
    value: z.string(),
  }),
  z.object({
    type: z.literal('date'),
    op: z.literal('between'),
    from: z.string(),
    to: z.string(),
  }),
  z.object({
    type: z.literal('term'),
    op: z.literal('in'),
    values: z.array(z.string()),
  }),
])
export type Condition = z.infer<typeof conditionSchema>

// ── SQuery (recursive) ────────────────────────────────────────────────────────
export type SQuery =
  | { type: 'and'; queries: SQuery[] }
  | { type: 'or'; queries: SQuery[] }
  | { type: 'match_all' }
  | { type: 'object_type'; object_type: DslObjectType }
  | { type: 'field_condition'; field: FieldRef; condition: Condition }
  | { type: 'has_related'; object_type: DslObjectType; query: SQuery }

// The tree's shape only. A view saved before a filter was hidden still has
// this shape, so saved views are read with it (parseSavedViewQuery below).
export const sQueryShapeSchema: z.ZodType<SQuery> = z.lazy(() =>
  z.union([
    z.object({ type: z.literal('and'), queries: z.array(sQueryShapeSchema) }),
    z.object({ type: z.literal('or'), queries: z.array(sQueryShapeSchema) }),
    z.object({ type: z.literal('match_all') }),
    z.object({
      type: z.literal('object_type'),
      object_type: objectTypeSchema,
    }),
    z.object({
      type: z.literal('field_condition'),
      field: fieldRefSchema,
      condition: conditionSchema,
    }),
    z.object({
      type: z.literal('has_related'),
      object_type: objectTypeSchema,
      query: sQueryShapeSchema,
    }),
  ])
)

// What the Smart View API accepts (POST/PUT /api/smart-views, POST
// /api/data/search): the shape, minus the hidden filters. Brief 50 PR 4: a
// query naming "Callable now" is refused (400) with a plain message instead of
// being saved, or searched, as if it filtered anything (compliance-filters.ts).
export const sQuerySchema: z.ZodType<SQuery> = sQueryShapeSchema.superRefine((q, ctx) => {
  const hidden = firstUnavailableFilter(q)
  if (hidden) ctx.addIssue({ code: 'custom', message: unavailableFilterMessage(hidden) })
})

/**
 * Read a saved view's stored query. Malformed → the zod error, as before.
 * Brief 50 PR 4: a view saved with a hidden filter → UnavailableFilterError,
 * whose message is plain English, so the page says so instead of applying the
 * rest of the view as if the filter had run.
 */
export function parseSavedViewQuery(raw: unknown): SQuery {
  const q = sQueryShapeSchema.parse(raw)
  const hidden = firstUnavailableFilter(q)
  if (hidden) throw new UnavailableFilterError(hidden)
  return q
}

export { UnavailableFilterError }

// Sort spec attached to a SavedView (separate from the s_query tree).
export const sortSpecSchema = z.array(
  z.object({
    field: z.string(),
    direction: z.enum(['asc', 'desc']).default('desc'),
  })
)
export type SortSpec = z.infer<typeof sortSpecSchema>
