'use client'

import { Badge } from '@/components/ui/Badge'
import { controlBase, controlBorder } from '@/components/ui/Field'
import { cn } from '@/lib/ui/cn'
import type { ColumnMapping, MappingTarget } from '@/lib/core-data/importer/ai-mapping'
import { choiceValue, columnChoices, targetForChoice, type CustomFieldChoice } from '@/lib/core-data/importer/mapping-edit'

// Brief 50 PR 6 (open item 6.6): one row per column of the file, each with a
// field picker (including "Don't import") instead of the AI's choice as fixed
// text. A column Ryan changed says so; one whose AI answer had to be rewritten
// asks him to check it. Native selects: keyboard and phone friendly, and the
// picker needs <optgroup>, which the kit's Select doesn't have (as in
// DestinationStep). Presentational: the page owns the mapping.

export interface MappingTableProps {
  mapping: ColumnMapping[]
  /** What the screen opened with, per column (the AI's choice, or "Don't import"). */
  aiTargets: Record<string, MappingTarget>
  customFields: CustomFieldChoice[]
  /** Columns whose AI answer was unclear and was rewritten. */
  coerced: string[]
  /** The mapping didn't come from the AI: no confidence to show. */
  manual: boolean
  disabled?: boolean
  onChange: (column: string, target: MappingTarget) => void
}

const cell = 'border-r border-line px-3 py-2 last:border-r-0'
const head = 'h-[41px] border-b border-r border-line px-3 font-bold text-fg last:border-r-0'

export function MappingTable({ mapping, aiTargets, customFields, coerced, manual, disabled, onChange }: MappingTableProps) {
  return (
    <div className="mb-4 border-b border-line">
      <table className="w-full border-collapse text-base">
        <thead className="bg-bg text-left">
          <tr>
            <th className={cn(head, 'w-[40%] sm:w-auto')}>Column</th>
            <th className={cn(head, 'hidden sm:table-cell')}>Samples</th>
            <th className={head}>Import as</th>
            {!manual && <th className={cn(head, 'hidden sm:table-cell')}>AI conf.</th>}
          </tr>
        </thead>
        <tbody>
          {mapping.map((m) => {
            const ai = aiTargets[m.column] ?? m.target
            const changed = !manual && choiceValue(m.target) !== choiceValue(ai)
            const samples = m.sampleValues.slice(0, 3).join(', ')
            return (
              <tr key={m.column} className="border-b border-line align-top">
                <td className={cn(cell, 'font-medium break-words text-fg')}>{m.column}</td>
                <td className={cn(cell, 'hidden break-words text-muted sm:table-cell')}>{samples}</td>
                <td className={cell}>
                  <select
                    aria-label={`Field for the column ${m.column}`}
                    value={choiceValue(m.target)}
                    disabled={disabled}
                    onChange={(e) => onChange(m.column, targetForChoice(e.target.value, m.column, ai, customFields))}
                    className={cn(controlBase, controlBorder(), 'h-8 min-w-0')}
                  >
                    {columnChoices(m.column, ai, customFields).map((group) =>
                      group.label === null ? (
                        group.options.map((o) => (
                          <option key={o.value} value={o.value}>
                            {o.label}
                          </option>
                        ))
                      ) : (
                        <optgroup key={group.label} label={group.label}>
                          {group.options.map((o) => (
                            <option key={o.value} value={o.value}>
                              {o.label}
                            </option>
                          ))}
                        </optgroup>
                      ),
                    )}
                  </select>
                  {changed && (
                    <Badge tone="accent" className="mt-1.5">
                      Changed
                    </Badge>
                  )}
                  {coerced.includes(m.column) && (
                    <p className="mt-1 text-xs text-warning">Check this one: the AI&apos;s answer for it was unclear.</p>
                  )}
                  {samples && <p className="mt-1 text-xs break-words text-subtle sm:hidden">e.g. {samples}</p>}
                </td>
                {!manual && (
                  <td className={cn(cell, 'hidden text-fg sm:table-cell')}>{changed ? '—' : `${Math.round(m.confidence * 100)}%`}</td>
                )}
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}
