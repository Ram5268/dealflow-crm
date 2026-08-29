'use client'

import * as RT from '@radix-ui/react-tooltip'
import { cn } from '@/lib/ui/cn'

/** Mount once, near the root. 300ms delay per brief §6. */
export function TooltipProvider({ children }: { children: React.ReactNode }) {
  return (
    <RT.Provider delayDuration={300} skipDelayDuration={200}>
      {children}
    </RT.Provider>
  )
}

export function Tooltip({
  content,
  side = 'bottom',
  children,
  className,
}: {
  content: React.ReactNode
  side?: 'top' | 'right' | 'bottom' | 'left'
  children: React.ReactNode
  className?: string
}) {
  if (!content) return <>{children}</>
  return (
    <RT.Root>
      <RT.Trigger asChild>{children}</RT.Trigger>
      <RT.Portal>
        <RT.Content
          side={side}
          sideOffset={6}
          className={cn(
            'z-50 rounded-md border border-line bg-overlay px-2 py-1',
            'text-xs text-fg shadow-md',
            'select-none',
            className,
          )}
        >
          {content}
        </RT.Content>
      </RT.Portal>
    </RT.Root>
  )
}
