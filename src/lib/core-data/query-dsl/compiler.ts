import type {
  Condition,
  FieldRef,
  SortSpec,
  SQuery,
  DslObjectType,
} from './schema'
import { DNC_CLEAN_CONDITION_MESSAGE, dncCleanSql, isDncCleanTrue, unavailableFilterMessage } from './compliance-filters'

// ─────────────────────────────────────────────────────────────────────────────
// s_query → parameterized SQL compiler.
//
// Contract (brief §9 M1):
//  - Pure function. compile(sQuery, ctx) -> { whereSql, params }.
//  - EVERY value is a $N placeholder. Identifiers (table/column) are NEVER
//    interpolated from caller input — they are resolved through an allow-list
//    (FIELD_REGISTRY) so a malicious sQuery cannot inject SQL via a column name.
//  - `compliance` field refs (Brief 50 PR 4, compliance-filters.ts): 'dnc_clean'
//    compiles to SQL over the do-not-call data stored in the CRM; the hidden
//    'callable_now' is refused with a plain CompileError. (Both used to compile
//    to TRUE, lifted out "for post-fetch evaluation" that nothing ever ran, so
//    a view using either silently showed everyone.)
//  - Custom fields compile to a correlated EXISTS against CustomFieldValue,
//    choosing value_number / value_text / value_date from the definition type.
//  - Base object is always Lead (alias `lead`). Non-lead object refs compile to
//    correlated EXISTS subqueries.
// ─────────────────────────────────────────────────────────────────────────────

export type CustomFieldType =
  | 'text'
  | 'number'
  | 'date'
  | 'datetime'
  | 'url'
  | 'email'
  | 'choices'

export interface CompileContext {
  organizationId: string
  // definitionId -> field type; needed to pick the value_* column for custom fields.
  customFieldTypes: Record<string, CustomFieldType>
}

export interface CompiledQuery {
  // WHERE-clause fragment (already parenthesized where needed). Does NOT include
  // the leading `WHERE`. Always org-scoped by the executor separately.
  whereSql: string
  params: unknown[]
}

// Registry of query-able regular columns. Maps a DSL (table, column) to the
// real quoted DB column and its value kind. Prisma (no @map in schema) uses the
// model field name verbatim as the column name, so columns are camelCase and
// MUST be double-quoted. Anything not in this registry is rejected — this is the
// SQL-injection guard for identifiers.
type ColKind = 'text' | 'number' | 'date' | 'bool'
interface RelatedTable {
  // Physical table + correlation to lead.
  sql: string // e.g. '"Contact"'
  alias: string
  correlation: string // e.g. 'c."leadId" = lead.id'
  columns: Record<string, { col: string; kind: ColKind }>
}

const LEAD_COLUMNS: Record<string, { col: string; kind: ColKind }> = {
  displayName: { col: 'lead."displayName"', kind: 'text' },
  name: { col: 'lead."name"', kind: 'text' },
  description: { col: 'lead."description"', kind: 'text' },
  source: { col: 'lead."source"', kind: 'text' },
  statusId: { col: 'lead."statusId"', kind: 'text' },
  statusLabel: { col: 'lead."statusLabel"', kind: 'text' },
  url: { col: 'lead."url"', kind: 'text' },
  primaryAddressFull: { col: 'lead."primaryAddressFull"', kind: 'text' },
  primaryAddressSummary: { col: 'lead."primaryAddressSummary"', kind: 'text' },
  timezone: { col: 'lead."timezone"', kind: 'text' },
  priorityScore: { col: 'lead."priorityScore"', kind: 'number' },
  topMatchFit: { col: 'lead."topMatchFit"', kind: 'number' },
  captureStatus: { col: 'lead."captureStatus"', kind: 'text' },
  matchReason: { col: 'lead."matchReason"', kind: 'text' },
  mojoId: { col: 'lead."mojoId"', kind: 'text' },
  createdAt: { col: 'lead."createdAt"', kind: 'date' },
  updatedAt: { col: 'lead."updatedAt"', kind: 'date' },
  dealflowSignalSyncedAt: { col: 'lead."dealflowSignalSyncedAt"', kind: 'date' },
}

// Brief 45 [engineering precaution]: adding or removing a group label writes a
// timeline entry of type 'Group' (src/lib/core-data/lists/timeline.ts). That is
// a note about the label, not activity with the lead, so no Smart View counts
// it: every `activity` reference skips those rows. Brief 50 PR 4 [engineering
// precaution]: the same for Ryan's own edits to a lead, which Brief 50 PR 5
// writes as type 'Edit' (its LEAD_EDIT_ACTIVITY_TYPE); an edit is never
// activity with the homeowner.
export const TIMELINE_NOTE_TYPES = ['Group', 'Edit'] as const
export const NOT_A_TIMELINE_NOTE = `a."type" NOT IN (${TIMELINE_NOTE_TYPES.map((t) => `'${t}'`).join(', ')})`

// Related tables addressable by a `regular` field ref with a non-lead `table`.
const RELATED_TABLES: Record<string, RelatedTable> = {
  contact: {
    sql: '"Contact" c',
    alias: 'c',
    correlation: 'c."leadId" = lead.id',
    columns: {
      displayName: { col: 'c."displayName"', kind: 'text' },
      name: { col: 'c."name"', kind: 'text' },
      title: { col: 'c."title"', kind: 'text' },
      timezone: { col: 'c."timezone"', kind: 'text' },
    },
  },
  contactPhone: {
    sql: '"ContactPhone" cp JOIN "Contact" cpc ON cp."contactId" = cpc.id',
    alias: 'cp',
    correlation: 'cpc."leadId" = lead.id',
    columns: {
      phone: { col: 'cp."phone"', kind: 'text' },
      type: { col: 'cp."type"', kind: 'text' },
      lineType: { col: 'cp."lineType"', kind: 'text' },
    },
  },
  contactEmail: {
    sql: '"ContactEmail" ce JOIN "Contact" cec ON ce."contactId" = cec.id',
    alias: 'ce',
    correlation: 'cec."leadId" = lead.id',
    columns: {
      email: { col: 'ce."email"', kind: 'text' },
      type: { col: 'ce."type"', kind: 'text' },
    },
  },
  opportunity: {
    sql: '"Opportunity" o',
    alias: 'o',
    correlation: 'o."leadId" = lead.id',
    columns: {
      statusLabel: { col: 'o."statusLabel"', kind: 'text' },
      statusType: { col: 'o."statusType"', kind: 'text' },
      confidence: { col: 'o."confidence"', kind: 'number' },
      value: { col: 'o."value"', kind: 'number' },
    },
  },
  activity: {
    sql: '"Activity" a',
    alias: 'a',
    correlation: `a."leadId" = lead.id AND ${NOT_A_TIMELINE_NOTE}`,
    columns: {
      type: { col: 'a."type"', kind: 'text' },
      activityAt: { col: 'a."activityAt"', kind: 'date' },
    },
  },
}

// Existence check: does the lead have >=1 related row of this object type?
const OBJECT_TYPE_EXISTS: Record<DslObjectType, string | null> = {
  lead: null, // querying leads — always true
  contact: 'EXISTS (SELECT 1 FROM "Contact" c WHERE c."leadId" = lead.id)',
  opportunity:
    'EXISTS (SELECT 1 FROM "Opportunity" o WHERE o."leadId" = lead.id)',
  activity: `EXISTS (SELECT 1 FROM "Activity" a WHERE a."leadId" = lead.id AND ${NOT_A_TIMELINE_NOTE})`,
}

class ParamBag {
  readonly params: unknown[] = []
  add(value: unknown): string {
    this.params.push(value)
    return `$${this.params.length}`
  }
}

function fail(msg: string): never {
  throw new CompileError(msg)
}

export class CompileError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'CompileError'
  }
}

// Emit SQL for a single condition against a resolved column of a given kind.
function emitCondition(
  colSql: string,
  kind: ColKind,
  condition: Condition,
  bag: ParamBag
): string {
  switch (condition.type) {
    case 'text': {
      if (kind !== 'text')
        fail(`text condition on non-text column ${colSql}`)
      switch (condition.mode) {
        case 'exact':
          return `${colSql} = ${bag.add(condition.value)}`
        case 'contains':
          return `${colSql} ILIKE ${bag.add('%' + escapeLike(condition.value) + '%')}`
        case 'full_words': {
          // Word-boundary match: use a regex on word boundaries, case-insensitive.
          return `${colSql} ~* ${bag.add('\\y' + escapeRegex(condition.value) + '\\y')}`
        }
      }
      return fail('unreachable text mode')
    }
    case 'number': {
      if (kind !== 'number')
        fail(`number condition on non-number column ${colSql}`)
      if (condition.op === 'in') {
        if (condition.values.length === 0) return 'FALSE'
        const placeholders = condition.values.map((v) => bag.add(v)).join(', ')
        return `${colSql} IN (${placeholders})`
      }
      const opMap = { gt: '>', lt: '<', gte: '>=', lte: '<=', eq: '=' } as const
      return `${colSql} ${opMap[condition.op]} ${bag.add(condition.value)}`
    }
    case 'date': {
      if (kind !== 'date') fail(`date condition on non-date column ${colSql}`)
      // Params arrive as text; cast to timestamptz so the comparison type-checks.
      if (condition.op === 'between') {
        return `${colSql} >= ${bag.add(condition.from)}::timestamptz AND ${colSql} <= ${bag.add(condition.to)}::timestamptz`
      }
      const op = condition.op === 'before' ? '<' : '>'
      return `${colSql} ${op} ${bag.add(condition.value)}::timestamptz`
    }
    case 'term': {
      // term/in works against text-ish columns (status labels, types, etc.)
      if (condition.values.length === 0) return 'FALSE'
      const placeholders = condition.values.map((v) => bag.add(v)).join(', ')
      return `${colSql} IN (${placeholders})`
    }
  }
}

// `base` is the table the surrounding query is rooted at: 'lead' at the top
// level, or a related object type inside a has_related subquery. When a regular
// field targets the current base, it resolves to a bare column (already in the
// FROM); otherwise a related field is wrapped in its own correlated EXISTS.
function resolveRegular(
  field: Extract<FieldRef, { kind: 'regular' }>,
  base: string
): { colSql: string; kind: ColKind; wrapExists: RelatedTable | null } {
  if (field.table === 'lead') {
    const entry = LEAD_COLUMNS[field.column]
    if (!entry) fail(`unknown lead column: ${field.column}`)
    return { colSql: entry.col, kind: entry.kind, wrapExists: null }
  }
  const rel = RELATED_TABLES[field.table]
  if (!rel) fail(`unknown table: ${field.table}`)
  const entry = rel.columns[field.column]
  if (!entry) fail(`unknown ${field.table} column: ${field.column}`)
  // Inside a has_related on this same table, the row is already joined — bare.
  const wrapExists = field.table === base ? null : rel
  return { colSql: entry.col, kind: entry.kind, wrapExists }
}

const CUSTOM_VALUE_COLUMN: Record<CustomFieldType, { col: string; kind: ColKind }> = {
  text: { col: 'cfv."valueText"', kind: 'text' },
  email: { col: 'cfv."valueText"', kind: 'text' },
  url: { col: 'cfv."valueText"', kind: 'text' },
  choices: { col: 'cfv."valueText"', kind: 'text' },
  number: { col: 'cfv."valueNumber"', kind: 'number' },
  date: { col: 'cfv."valueDate"', kind: 'date' },
  datetime: { col: 'cfv."valueDate"', kind: 'date' },
}

function emitFieldCondition(
  field: FieldRef,
  condition: Condition,
  bag: ParamBag,
  ctx: CompileContext,
  base: string
): string {
  if (field.kind === 'compliance') {
    // Brief 50 PR 4: never TRUE. "Do-not-call clean" (condition "true" only)
    // is SQL; anything else, i.e. the hidden "Callable now", is refused out loud.
    if (field.predicate !== 'dnc_clean') fail(unavailableFilterMessage(field.predicate))
    if (!isDncCleanTrue(condition)) fail(DNC_CLEAN_CONDITION_MESSAGE)
    return dncCleanSql(bag.add(ctx.organizationId))
  }

  if (field.kind === 'custom') {
    const type = ctx.customFieldTypes[field.definitionId]
    if (!type) fail(`unknown custom field definition: ${field.definitionId}`)
    const value = CUSTOM_VALUE_COLUMN[type]
    const defParam = bag.add(field.definitionId)
    const inner = emitCondition(value.col, value.kind, condition, bag)
    return (
      `EXISTS (SELECT 1 FROM "CustomFieldValue" cfv ` +
      `WHERE cfv."objectId" = lead.id AND cfv."definitionId" = ${defParam} ` +
      `AND (${inner}))`
    )
  }

  // regular
  const { colSql, kind, wrapExists } = resolveRegular(field, base)
  const inner = emitCondition(colSql, kind, condition, bag)
  if (!wrapExists) return inner
  return (
    `EXISTS (SELECT 1 FROM ${wrapExists.sql} ` +
    `WHERE ${wrapExists.correlation} AND (${inner}))`
  )
}

function emitNode(
  node: SQuery,
  bag: ParamBag,
  ctx: CompileContext,
  base: string
): string {
  switch (node.type) {
    case 'match_all':
      return 'TRUE'
    case 'and': {
      if (node.queries.length === 0) return 'TRUE'
      return (
        '(' +
        node.queries
          .map((q) => emitNode(q, bag, ctx, base))
          .join(' AND ') +
        ')'
      )
    }
    case 'or': {
      if (node.queries.length === 0) return 'FALSE'
      return (
        '(' +
        node.queries
          .map((q) => emitNode(q, bag, ctx, base))
          .join(' OR ') +
        ')'
      )
    }
    case 'object_type': {
      const sql = OBJECT_TYPE_EXISTS[node.object_type]
      return sql ?? 'TRUE'
    }
    case 'field_condition':
      return emitFieldCondition(node.field, node.condition, bag, ctx, base)
    case 'has_related':
      return emitHasRelated(node, bag, ctx)
  }
}

// has_related: the lead has >=1 related object of `object_type` for which the
// nested sub-query holds. The subquery is rooted at the related table, so field
// refs targeting that table inside `query` resolve bare (no re-wrapping).
function emitHasRelated(
  node: Extract<SQuery, { type: 'has_related' }>,
  bag: ParamBag,
  ctx: CompileContext
): string {
  if (node.object_type === 'lead') {
    // Degenerate: "leads related to leads" — just evaluate the sub-query inline.
    return emitNode(node.query, bag, ctx, 'lead')
  }
  const rel = RELATED_TABLES[node.object_type]
  if (!rel) fail(`has_related on unsupported object_type: ${node.object_type}`)
  const inner = emitNode(node.query, bag, ctx, node.object_type)
  return (
    `EXISTS (SELECT 1 FROM ${rel.sql} ` +
    `WHERE ${rel.correlation} AND (${inner}))`
  )
}

export function compile(sQuery: SQuery, ctx: CompileContext): CompiledQuery {
  const bag = new ParamBag()
  const whereSql = emitNode(sQuery, bag, ctx, 'lead')
  return { whereSql, params: bag.params }
}

// Build the ORDER BY clause from a sort spec. Only allow-listed lead columns are
// sortable (identifier safety); everything is NULLS LAST so unranked leads sink.
// lead.id always comes last: a unique tiebreaker, so rows that tie on the sort
// (flat DealFlow ranking, NULL scores) keep one order, and LIMIT/OFFSET pages
// and capped lists are the same on every run.
export function compileOrderBy(sort: SortSpec): string {
  if (!sort || sort.length === 0) {
    return 'ORDER BY lead."priorityScore" DESC NULLS LAST, lead.id ASC'
  }
  const parts = sort.map((s) => {
    const entry = LEAD_COLUMNS[s.field]
    if (!entry) fail(`unknown sort field: ${s.field}`)
    const dir = s.direction === 'asc' ? 'ASC' : 'DESC'
    return `${entry.col} ${dir} NULLS LAST`
  })
  return 'ORDER BY ' + [...parts, 'lead.id ASC'].join(', ')
}

function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (m) => '\\' + m)
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}
