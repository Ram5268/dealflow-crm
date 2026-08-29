'use client'

import * as RM from '@radix-ui/react-dropdown-menu'
import { cn } from '@/lib/ui/cn'

export const DropdownRoot = RM.Root
export const DropdownTrigger = RM.Trigger

export function DropdownContent({
  align = 'end',
  className,
  children,
}: {
  align?: 'start' | 'center' | 'end'
  className?: string
  children: React.ReactNode
}) {
  return (
    <RM.Portal>
      <RM.Content
        align={align}
        sideOffset={4}
        className={cn(
          'z-50 min-w-44 rounded-md border border-line bg-overlay p-1 shadow-md',
          'data-[state=open]:animate-[dfFadeIn_100ms_ease-out]',
          className,
        )}
      >
        {children}
      </RM.Content>
    </RM.Portal>
  )
}

export function DropdownItem({
  onSelect,
  disabled,
  danger,
  shortcut,
  className,
  children,
}: {
  onSelect?: () => void
  disabled?: boolean
  danger?: boolean
  shortcut?: React.ReactNode
  className?: string
  children: React.ReactNode
}) {
  return (
    <RM.Item
      disabled={disabled}
      onSelect={onSelect}
      className={cn(
        'flex h-7 cursor-default select-none items-center gap-2 rounded px-2',
        'text-sm outline-none',
        'data-[highlighted]:bg-hover',
        'data-[disabled]:pointer-events-none data-[disabled]:opacity-50',
        danger ? 'text-danger' : 'text-fg',
        className,
      )}
    >
      <span className="min-w-0 flex-1 truncate">{children}</span>
      {shortcut && <span className="shrink-0 text-subtle">{shortcut}</span>}
    </RM.Item>
  )
}

export function DropdownLabel({ children }: { children: React.ReactNode }) {
  return <RM.Label className="px-2 py-1 text-xs font-medium text-subtle">{children}</RM.Label>
}

export function DropdownSeparator() {
  return <RM.Separator className="my-1 h-px bg-line" />
}
