'use client'

import { Search } from 'lucide-react'
import { Kbd } from '@/components/ui'
import { cn } from '@/lib/ui/cn'

/**
 * Top-bar search affordance. Close puts a wide search box at the top of every
 * screen; ours launches the ⌘K palette rather than owning its own result list,
 * so there is exactly one search surface to learn.
 *
 * DEVIATION (planner parity call said "Input that opens ⌘K on focus"): this is
 * a button styled as an input, not an <input>. An input cannot open the palette
 * on focus without looping — Radix restores focus to the previously focused
 * element when the dialog closes, so focus would land back on the input and
 * immediately reopen it. A button is loop-free, and keyboard users get correct
 * Enter/Space semantics plus a real accessible name.
 */
export function SearchLauncher({ onOpenPalette }: { onOpenPalette: () => void }) {
  return (
    <button
      type="button"
      onClick={onOpenPalette}
      aria-label="Search — opens the command palette"
      aria-keyshortcuts="Meta+K Control+K"
      className={cn(
        // Close's search is a borderless filled pill, not a bordered input —
        // so this deliberately does NOT reuse controlBase/controlBorder.
        'flex h-10 w-full max-w-[500px] flex-1 items-center gap-2 rounded-md',
        'bg-active px-3 text-left text-sm text-subtle transition-colors',
        'hover:bg-[color-mix(in_srgb,var(--bg-active)_92%,black)]',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent',
      )}
    >
      <Search size={16} className="shrink-0 text-subtle" />
      <span className="min-w-0 flex-1 truncate">Search…</span>
      <Kbd className="shrink-0">⌘K</Kbd>
    </button>
  )
}
