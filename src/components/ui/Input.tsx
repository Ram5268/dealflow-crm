'use client'

import { forwardRef, useId } from 'react'
import { cn } from '@/lib/ui/cn'
import { Field, controlBase, controlBorder } from './Field'

export interface InputProps extends React.InputHTMLAttributes<HTMLInputElement> {
  label?: string
  hint?: string
  error?: string
  /** Rendered inside the control, left of the text (e.g. a search glyph). */
  leading?: React.ReactNode
}

export const Input = forwardRef<HTMLInputElement, InputProps>(function Input(
  { label, hint, error, leading, className, id, required, ...rest },
  ref,
) {
  const autoId = useId()
  const inputId = id ?? autoId

  const control = (
    <input
      ref={ref}
      id={inputId}
      required={required}
      aria-invalid={error ? true : undefined}
      className={cn(
        controlBase,
        controlBorder(Boolean(error)),
        'h-8',
        leading ? 'pl-7' : undefined,
        className,
      )}
      {...rest}
    />
  )

  return (
    <Field label={label} hint={hint} error={error} htmlFor={inputId} required={required}>
      {leading ? (
        <div className="relative">
          <span className="pointer-events-none absolute left-2 top-1/2 -translate-y-1/2 text-subtle">
            {leading}
          </span>
          {control}
        </div>
      ) : (
        control
      )}
    </Field>
  )
})
