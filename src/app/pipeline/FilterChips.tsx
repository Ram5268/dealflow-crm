'use client'

import { X } from 'lucide-react'
import { Button } from '@/components/ui'
import { PIPELINE_FILTER_KEYS, type PipelineFilters } from '@/lib/core-data/lists/types'
import { chipLabel, type FilterNames } from './filters'

/** The filters in use, each removable on its own, plus "Clear all". Search has its own box. */
export function FilterChips({
  filters,
  names,
  onRemove,
  onClear,
}: {
  filters: PipelineFilters
  names: FilterNames
  onRemove: (key: keyof PipelineFilters) => void
  onClear: () => void
}) {
  const used = PIPELINE_FILTER_KEYS.filter((k) => k !== 'q' && filters[k])
  if (used.length === 0) return null
  return (
    <div data-testid="filter-chips" className="flex shrink-0 flex-wrap items-center gap-1.5 border-b border-line px-4 py-2">
      {used.map((key) => {
        const label = chipLabel(key, filters[key]!, names)
        return (
          <span key={key} className="inline-flex h-6 max-w-full items-center gap-1 rounded-full bg-active pl-2.5 pr-1 text-sm text-fg">
            <span className="truncate">{label}</span>
            <button
              type="button"
              aria-label={`Remove filter: ${label}`}
              onClick={() => onRemove(key)}
              className="inline-flex h-4 w-4 shrink-0 items-center justify-center rounded-full text-subtle transition-colors hover:bg-hover hover:text-fg"
            >
              <X size={11} />
            </button>
          </span>
        )
      })}
      <Button size="sm" variant="ghost" onClick={onClear}>
        Clear all
      </Button>
    </div>
  )
}
