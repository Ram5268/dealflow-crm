'use client'

import * as RSw from '@radix-ui/react-switch'
import { useId } from 'react'
import { cn } from '@/lib/ui/cn'

export function Switch({
  checked,
  onCheckedChange,
  label,
  disabled,
  className,
}: {
  checked?: boolean
  onCheckedChange?: (c: boolean) => void
  label?: string
  disabled?: boolean
  className?: string
}) {
  const id = useId()
  const sw = (
    <RSw.Root
      id={id}
      checked={checked}
      onCheckedChange={onCheckedChange}
      disabled={disabled}
      className={cn(
        'relative inline-flex h-4 w-7 shrink-0 items-center rounded-full',
        'border border-transparent bg-line-strong transition-colors duration-100',
        'data-[state=checked]:bg-accent',
        'disabled:cursor-not-allowed disabled:opacity-50',
        className,
      )}
    >
      <RSw.Thumb
        className={cn(
          'block h-3 w-3 translate-x-0.5 rounded-full bg-white shadow-sm',
          'transition-transform duration-100 will-change-transform',
          'data-[state=checked]:translate-x-[14px]',
        )}
      />
    </RSw.Root>
  )
  if (!label) return sw
  return (
    <div className="inline-flex items-center gap-2">
      {sw}
      <label htmlFor={id} className="cursor-pointer text-sm text-fg select-none">
        {label}
      </label>
    </div>
  )
}
