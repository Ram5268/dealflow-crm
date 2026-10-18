'use client'

import { useCallback } from 'react'
import { ChevronDown, ChevronUp } from 'lucide-react'
import { cn } from '@/lib/ui/cn'
import { Checkbox } from './Checkbox'

export type SortDir = 'asc' | 'desc'
export interface SortState {
  key: string
  dir: SortDir
}

export interface Column<T> {
  key: string
  header: string
  sortable?: boolean
  /** Any CSS width; omit to let the column flex. */
  width?: string
  align?: 'left' | 'right'
  cell: (row: T) => React.ReactNode
}

export interface DataTableProps<T> {
  columns: Column<T>[]
  rows: T[]
  getRowId: (row: T) => string
  sort?: SortState
  onSortChange?: (s: SortState) => void
  /** Provide both to enable selection; omit for a plain table. */
  selectedIds?: Set<string>
  onSelectedChange?: (next: Set<string>) => void
  /** Enter / click on a row. */
  onRowActivate?: (row: T) => void
  /** Extra data-* attributes for a row's <tr> (Brief 45: data-rank on ranked rows). */
  rowAttributes?: (row: T) => Partial<Record<`data-${string}`, string | number>> | undefined
  empty?: React.ReactNode
  className?: string
}

/**
 * Dense data table. Headless in the sense that every cell is caller-rendered;
 * the component owns only layout, sorting affordances, selection and keyboard
 * navigation.
 *
 * Keyboard model mirrors Close: rows are focusable, Up/Down walk the list,
 * Enter opens, Space toggles selection without opening.
 */
export function DataTable<T>({
  columns,
  rows,
  getRowId,
  sort,
  onSortChange,
  selectedIds,
  onSelectedChange,
  onRowActivate,
  rowAttributes,
  empty,
  className,
}: DataTableProps<T>) {
  const selectable = Boolean(selectedIds && onSelectedChange)
  const allSelected = selectable && rows.length > 0 && rows.every((r) => selectedIds!.has(getRowId(r)))
  const someSelected = selectable && rows.some((r) => selectedIds!.has(getRowId(r)))

  const toggleAll = useCallback(() => {
    if (!selectable) return
    onSelectedChange!(allSelected ? new Set() : new Set(rows.map(getRowId)))
  }, [selectable, allSelected, rows, getRowId, onSelectedChange])

  const toggleOne = useCallback(
    (id: string) => {
      if (!selectable) return
      const next = new Set(selectedIds!)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      onSelectedChange!(next)
    },
    [selectable, selectedIds, onSelectedChange],
  )

  const headerClick = (col: Column<T>) => {
    if (!col.sortable || !onSortChange) return
    const dir: SortDir = sort?.key === col.key && sort.dir === 'asc' ? 'desc' : 'asc'
    onSortChange({ key: col.key, dir })
  }

  // Roving focus across rows; no state, just DOM sibling walking.
  const onRowKeyDown = (e: React.KeyboardEvent<HTMLTableRowElement>, row: T) => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault()
      const sib =
        e.key === 'ArrowDown'
          ? e.currentTarget.nextElementSibling
          : e.currentTarget.previousElementSibling
      if (sib instanceof HTMLElement) sib.focus()
      return
    }
    if (e.key === 'Enter') {
      e.preventDefault()
      onRowActivate?.(row)
      return
    }
    if (e.key === ' ' && selectable) {
      e.preventDefault()
      toggleOne(getRowId(row))
    }
  }

  if (rows.length === 0 && empty) {
    return <div className={cn('rounded-lg border border-line bg-elevated', className)}>{empty}</div>
  }

  return (
    <div className={cn('overflow-x-auto bg-elevated', className)}>
      <table className="w-full border-collapse text-sm">
        {/* Close bands the header in the page ground, not the card white. */}
        <thead className="sticky top-0 z-10 bg-bg">
          <tr>
            {selectable && (
              <th className="w-9 border-b border-r border-line px-3 py-0">
                <Checkbox
                  checked={allSelected ? true : someSelected ? 'indeterminate' : false}
                  onCheckedChange={toggleAll}
                />
              </th>
            )}
            {columns.map((c) => {
              const active = sort?.key === c.key
              return (
                <th
                  key={c.key}
                  style={c.width ? { width: c.width } : undefined}
                  aria-sort={active ? (sort!.dir === 'asc' ? 'ascending' : 'descending') : undefined}
                  className={cn(
                    // Close: 41px tall, 14px/700 near-black, ruled on every edge.
                    'h-[41px] border-b border-r border-line px-3 text-base font-bold text-fg',
                    'last:border-r-0',
                    c.align === 'right' ? 'text-right' : 'text-left',
                  )}
                >
                  {c.sortable && onSortChange ? (
                    <button
                      type="button"
                      onClick={() => headerClick(c)}
                      className={cn(
                        'inline-flex items-center gap-1 rounded transition-colors hover:text-fg',
                        active && 'text-fg',
                        c.align === 'right' && 'flex-row-reverse',
                      )}
                    >
                      {c.header}
                      {active &&
                        (sort!.dir === 'asc' ? <ChevronUp size={12} /> : <ChevronDown size={12} />)}
                    </button>
                  ) : (
                    c.header
                  )}
                </th>
              )
            })}
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => {
            const id = getRowId(row)
            const isSelected = selectable && selectedIds!.has(id)
            return (
              <tr
                key={id}
                {...rowAttributes?.(row)}
                tabIndex={0}
                onKeyDown={(e) => onRowKeyDown(e, row)}
                onClick={() => onRowActivate?.(row)}
                className={cn(
                  'h-10 border-b border-line last:border-b-0',
                  'transition-colors duration-75',
                  'focus:outline-none focus-visible:bg-hover',
                  isSelected ? 'bg-accent-subtle' : 'hover:bg-hover',
                  onRowActivate && 'cursor-pointer',
                )}
              >
                {selectable && (
                  <td
                    className="border-r border-line px-3"
                    // The checkbox is its own control; a click here must not
                    // also open the row.
                    onClick={(e) => e.stopPropagation()}
                  >
                    <Checkbox checked={isSelected} onCheckedChange={() => toggleOne(id)} />
                  </td>
                )}
                {columns.map((c) => (
                  <td
                    key={c.key}
                    className={cn(
                      'border-r border-line px-3 text-base text-fg last:border-r-0',
                      c.align === 'right' ? 'text-right' : 'text-left',
                    )}
                  >
                    {c.cell(row)}
                  </td>
                ))}
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}
