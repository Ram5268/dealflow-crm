'use client'

import * as RC from '@radix-ui/react-checkbox'
import { Check, Minus } from 'lucide-react'
import { useId } from 'react'
import { cn } from '@/lib/ui/cn'

export function Checkbox({
  checked,
  onCheckedChange,
  label,
  disabled,
  className,
}: {
  /** `'indeterminate'` drives the mixed state used by table select-all. */
  checked?: boolean | 'indeterminate'
  onCheckedChange?: (c: boolean | 'indeterminate') => void
  label?: string
  disabled?: boolean
  className?: string
}) {
  const id = useId()
  const box = (
    <RC.Root
      id={id}
      checked={checked}
      onCheckedChange={onCheckedChange}
      disabled={disabled}
      className={cn(
        'inline-flex h-4 w-4 shrink-0 items-center justify-center rounded-sm border',
        'border-line-strong bg-elevated transition-colors duration-100',
        'data-[state=checked]:border-accent data-[state=checked]:bg-accent',
        'data-[state=indeterminate]:border-accent data-[state=indeterminate]:bg-accent',
        'disabled:cursor-not-allowed disabled:opacity-50',
        className,
      )}
    >
      <RC.Indicator className="text-accent-fg">
        {checked === 'indeterminate' ? <Minus size={11} /> : <Check size={11} />}
      </RC.Indicator>
    </RC.Root>
  )
  if (!label) return box
  return (
    <div className="inline-flex items-center gap-2">
      {box}
      <label htmlFor={id} className="cursor-pointer text-sm text-fg select-none">
        {label}
      </label>
    </div>
  )
}
