'use client'

import * as RP from '@radix-ui/react-popover'
import { cn } from '@/lib/ui/cn'

export const PopoverRoot = RP.Root
export const PopoverTrigger = RP.Trigger
export const PopoverClose = RP.Close

export function PopoverContent({
  align = 'start',
  side = 'bottom',
  className,
  children,
}: {
  align?: 'start' | 'center' | 'end'
  side?: 'top' | 'right' | 'bottom' | 'left'
  className?: string
  children: React.ReactNode
}) {
  return (
    <RP.Portal>
      <RP.Content
        align={align}
        side={side}
        sideOffset={4}
        className={cn(
          'z-50 rounded-md border border-line bg-overlay p-2 shadow-md',
          'data-[state=open]:animate-[dfFadeIn_100ms_ease-out]',
          className,
        )}
      >
        {children}
      </RP.Content>
    </RP.Portal>
  )
}
