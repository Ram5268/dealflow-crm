import { z } from 'zod'

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

export const sQuerySchema: z.ZodType<SQuery> = z.lazy(() =>
  z.union([
    z.object({ type: z.literal('and'), queries: z.array(sQuerySchema) }),
    z.object({ type: z.literal('or'), queries: z.array(sQuerySchema) }),
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
      query: sQuerySchema,
    }),
  ])
)

// Sort spec attached to a SavedView (separate from the s_query tree).
export const sortSpecSchema = z.array(
  z.object({
    field: z.string(),
    direction: z.enum(['asc', 'desc']).default('desc'),
  })
)
export type SortSpec = z.infer<typeof sortSpecSchema>
