// Brief 50 PR 6 (open item 6.6; audit L23/L5): Ryan changes each column's
// mapping on the review screen before committing, including "Don't import".
// Before this the screen only showed the AI's choices; a wrong one (the Mojo
// ID column taken for a custom field) could not be fixed, and an unreadable AI
// answer was a dead end.
//
// The pure pieces behind the screen's pickers and its checks, browser-safe
// (types only from ai-mapping.ts, which reads files on the server). The commit
// route runs the same checks.
import type { ColumnMapping, MappingTarget } from './ai-mapping'

export type StandardField = Extract<MappingTarget, { kind: 'standard_field' }>['field']

/** The words Ryan sees for each field the import fills. */
export const FIELD_LABELS: Record<StandardField, string> = {
  'Lead.name': 'Owner name',
  'Contact.name': 'Second owner or contact name',
  'Lead.primaryAddressFull': 'Property address',
  'Lead.mojoId': 'Mojo ID',
  'Lead.statusLabel': 'Status',
  'ContactPhone.phone': 'Phone',
  'ContactPhone.type': 'Phone type',
  'ContactEmail.email': 'Email',
  'Contact.title': "Contact's title",
}

/** The order of the main fields in a column's picker. */
export const FIELD_ORDER: readonly StandardField[] = [
  'Lead.mojoId',
  'Lead.name',
  'Contact.name',
  'Lead.primaryAddressFull',
  'ContactPhone.phone',
  'ContactPhone.type',
  'ContactEmail.email',
  'Lead.statusLabel',
  'Contact.title',
]

export const IGNORE_LABEL = "Don't import"

// Fields a row is matched to a person on (commit-worker's findExistingLead,
// and its "nothing to identify this row" skip).
const MATCH_FIELDS: readonly StandardField[] = ['Lead.mojoId', 'ContactPhone.phone', 'Lead.name', 'Contact.name', 'Lead.primaryAddressFull']
// Fields that take any number of columns; every other field keeps one value.
const MANY_COLUMNS: readonly StandardField[] = ['ContactPhone.phone', 'ContactEmail.email']

export const NOTHING_TO_MATCH =
  'Choose at least one column for the Mojo ID, a phone, a name or the property address, so each row can be matched to a person. As it is, every row would be skipped.'

export interface CustomFieldChoice {
  definitionId: string
  name: string
  type: string
}

export interface ChoiceGroup {
  /** null: shown above the groups (the "Don't import" choice). */
  label: string | null
  options: Array<{ value: string; label: string }>
}

const isField = (v: string): v is StandardField => (FIELD_ORDER as readonly string[]).includes(v)

/** The picker's value for a target: ignore | std:<field> | new | cf:<definition id>. */
export function choiceValue(target: MappingTarget): string {
  switch (target.kind) {
    case 'ignore':
      return 'ignore'
    case 'standard_field':
      return `std:${target.field}`
    case 'new_custom_field':
      return 'new'
    case 'existing_custom_field':
      return `cf:${target.definitionId}`
  }
}

// The new custom field a column would make: what the AI proposed for it, or a
// text field named after the column.
function newFieldFor(column: string, aiTarget: MappingTarget): Extract<MappingTarget, { kind: 'new_custom_field' }> {
  if (aiTarget.kind === 'new_custom_field') return aiTarget
  return { kind: 'new_custom_field', name: column.trim() || 'Untitled column', type: 'text' }
}

/**
 * One column's picker: "Don't import", the main fields, then the custom
 * fields (a new one for this column, unless one by that name exists already,
 * and every existing one).
 */
export function columnChoices(column: string, aiTarget: MappingTarget, customFields: CustomFieldChoice[]): ChoiceGroup[] {
  const fresh = newFieldFor(column, aiTarget)
  const custom = [
    ...(customFields.some((f) => f.name === fresh.name) ? [] : [{ value: 'new', label: `New custom field "${fresh.name}"` }]),
    ...customFields.map((f) => ({ value: `cf:${f.definitionId}`, label: `Custom field: ${f.name}` })),
  ]
  return [
    { label: null, options: [{ value: 'ignore', label: IGNORE_LABEL }] },
    { label: 'Main fields', options: FIELD_ORDER.map((f) => ({ value: `std:${f}`, label: FIELD_LABELS[f] })) },
    { label: 'Custom fields', options: custom },
  ]
}

/** The target a picker value stands for. A value the picker never offers throws. */
export function targetForChoice(value: string, column: string, aiTarget: MappingTarget, customFields: CustomFieldChoice[]): MappingTarget {
  if (value === 'ignore') return { kind: 'ignore' }
  if (value === 'new') return newFieldFor(column, aiTarget)
  if (value.startsWith('std:') && isField(value.slice(4))) return { kind: 'standard_field', field: value.slice(4) as StandardField }
  if (value.startsWith('cf:')) {
    const def = customFields.find((f) => f.definitionId === value.slice(3))
    if (def) return { kind: 'existing_custom_field', definitionId: def.definitionId }
  }
  throw new Error(`Not a field this import can fill: ${value}`)
}

/** The mapping with one column's target changed (a new array; the rest untouched). */
export function setColumnTarget(mapping: ColumnMapping[], column: string, target: MappingTarget): ColumnMapping[] {
  return mapping.map((m) => (m.column === column ? { ...m, target } : m))
}

const listColumns = (cols: string[]) => (cols.length === 2 ? `${cols[0]} and ${cols[1]}` : `${cols.slice(0, -1).join(', ')} and ${cols[cols.length - 1]}`)

export interface MappingCheck {
  /** Each one stops the commit. */
  problems: string[]
  /** Worth knowing; the commit can go ahead. */
  warnings: string[]
}

/**
 * Problems stop the commit: nothing to match a row on (every row would be
 * skipped), or one custom field fed by two columns (a merge writing both would
 * fail the row). A one-value field chosen for two columns only warns: the
 * commit has always used the last of them.
 */
export function checkMapping(mapping: ColumnMapping[], customFields: CustomFieldChoice[] = []): MappingCheck {
  const problems: string[] = []
  const warnings: string[] = []
  const fieldColumns = new Map<StandardField, string[]>()
  const customColumns = new Map<string, { name: string; columns: string[] }>()
  for (const m of mapping) {
    const t = m.target
    if (t.kind === 'standard_field') {
      fieldColumns.set(t.field, [...(fieldColumns.get(t.field) ?? []), m.column])
    } else if (t.kind === 'existing_custom_field' || t.kind === 'new_custom_field') {
      // A new field named like an existing one is that field (the commit
      // reuses a definition by name).
      const def =
        t.kind === 'existing_custom_field'
          ? customFields.find((f) => f.definitionId === t.definitionId)
          : customFields.find((f) => f.name === t.name)
      const key = def ? `def:${def.definitionId}` : t.kind === 'existing_custom_field' ? `def:${t.definitionId}` : `new:${t.name}`
      const name = def?.name ?? (t.kind === 'new_custom_field' ? t.name : 'a custom field')
      const entry = customColumns.get(key) ?? { name, columns: [] }
      entry.columns.push(m.column)
      customColumns.set(key, entry)
    }
  }
  if (!MATCH_FIELDS.some((f) => fieldColumns.has(f))) problems.push(NOTHING_TO_MATCH)
  for (const { name, columns } of customColumns.values()) {
    if (columns.length > 1) problems.push(`"${name}" is chosen for ${columns.length} columns (${listColumns(columns)}). Choose it for one column only.`)
  }
  for (const field of FIELD_ORDER) {
    const columns = fieldColumns.get(field) ?? []
    if (columns.length > 1 && !MANY_COLUMNS.includes(field)) {
      warnings.push(`"${FIELD_LABELS[field]}" is chosen for ${columns.length} columns (${listColumns(columns)}). Only the last one, ${columns[columns.length - 1]}, is imported.`)
    }
  }
  return { problems, warnings }
}

/**
 * Which columns decide who a row is (Mojo ID, phones, names, address). The
 * "already in your CRM" check runs again only when this changes.
 */
export function matchingKey(mapping: ColumnMapping[]): string {
  return JSON.stringify(
    mapping
      .flatMap((m) => (m.target.kind === 'standard_field' && MATCH_FIELDS.includes(m.target.field) ? [[m.column, m.target.field]] : []))
      .sort(),
  )
}
