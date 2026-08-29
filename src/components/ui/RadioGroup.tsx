'use client'

import * as RR from '@radix-ui/react-radio-group'
import { useId } from 'react'
import { cn } from '@/lib/ui/cn'

export function RadioGroup({
  value,
  onValueChange,
  options,
  disabled,
  className,
}: {
  value?: string
  onValueChange?: (v: string) => void
  options: { value: string; label: string; disabled?: boolean }[]
  disabled?: boolean
  className?: string
}) {
  const base = useId()
  return (
    <RR.Root
      value={value}
      onValueChange={onValueChange}
      disabled={disabled}
      className={cn('flex flex-col gap-2', className)}
    >
      {options.map((o) => {
        const id = `${base}-${o.value}`
        return (
          <div key={o.value} className="inline-flex items-center gap-2">
            <RR.Item
              id={id}
              value={o.value}
              disabled={o.disabled}
              className={cn(
                'inline-flex h-4 w-4 shrink-0 items-center justify-center rounded-full border',
                'border-line-strong bg-elevated transition-colors duration-100',
                'data-[state=checked]:border-accent',
                'disabled:cursor-not-allowed disabled:opacity-50',
              )}
            >
              <RR.Indicator className="block h-2 w-2 rounded-full bg-accent" />
            </RR.Item>
            <label htmlFor={id} className="cursor-pointer text-sm text-fg select-none">
              {o.label}
            </label>
          </div>
        )
      })}
    </RR.Root>
  )
}
