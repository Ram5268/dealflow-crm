'use client'

import * as RS from '@radix-ui/react-select'
import { Check, ChevronDown } from 'lucide-react'
import { useId } from 'react'
import { cn } from '@/lib/ui/cn'
import { Field } from './Field'

export interface SelectOption {
  value: string
  label: string
  disabled?: boolean
}

export function Select({
  value,
  onValueChange,
  options,
  placeholder = 'Select…',
  label,
  hint,
  error,
  disabled,
  className,
}: {
  value?: string
  onValueChange?: (v: string) => void
  options: SelectOption[]
  placeholder?: string
  label?: string
  hint?: string
  error?: string
  disabled?: boolean
  className?: string
}) {
  const id = useId()
  return (
    <Field label={label} hint={hint} error={error} htmlFor={id}>
      <RS.Root value={value} onValueChange={onValueChange} disabled={disabled}>
        <RS.Trigger
          id={id}
          aria-invalid={error ? true : undefined}
          className={cn(
            'inline-flex h-8 w-full items-center justify-between gap-2 rounded-md',
            'border bg-elevated px-2 text-sm text-fg',
            'transition-colors duration-100',
            'data-[placeholder]:text-subtle',
            'disabled:cursor-not-allowed disabled:opacity-50',
            error ? 'border-danger' : 'border-line hover:border-line-strong',
            className,
          )}
        >
          <RS.Value placeholder={placeholder} />
          <RS.Icon asChild>
            <ChevronDown size={14} className="shrink-0 text-subtle" />
          </RS.Icon>
        </RS.Trigger>
        <RS.Portal>
          <RS.Content
            position="popper"
            sideOffset={4}
            className={cn(
              'z-50 max-h-72 min-w-[var(--radix-select-trigger-width)] overflow-hidden',
              'rounded-md border border-line bg-overlay shadow-md',
              'data-[state=open]:animate-[dfFadeIn_100ms_ease-out]',
            )}
          >
            <RS.Viewport className="p-1">
              {options.map((o) => (
                <RS.Item
                  key={o.value}
                  value={o.value}
                  disabled={o.disabled}
                  className={cn(
                    'relative flex h-7 cursor-default select-none items-center rounded px-2 pr-7',
                    'text-sm text-fg outline-none',
                    'data-[highlighted]:bg-hover',
                    'data-[disabled]:pointer-events-none data-[disabled]:opacity-50',
                  )}
                >
                  <RS.ItemText>{o.label}</RS.ItemText>
                  <RS.ItemIndicator className="absolute right-2">
                    <Check size={13} className="text-accent" />
                  </RS.ItemIndicator>
                </RS.Item>
              ))}
            </RS.Viewport>
          </RS.Content>
        </RS.Portal>
      </RS.Root>
    </Field>
  )
}
