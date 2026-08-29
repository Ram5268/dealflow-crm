'use client'

import { forwardRef, useId } from 'react'
import { cn } from '@/lib/ui/cn'
import { Field, controlBase, controlBorder } from './Field'

export interface TextareaProps
  extends React.TextareaHTMLAttributes<HTMLTextAreaElement> {
  label?: string
  hint?: string
  error?: string
}

export const Textarea = forwardRef<HTMLTextAreaElement, TextareaProps>(
  function Textarea({ label, hint, error, className, id, required, rows = 4, ...rest }, ref) {
    const autoId = useId()
    const areaId = id ?? autoId
    return (
      <Field label={label} hint={hint} error={error} htmlFor={areaId} required={required}>
        <textarea
          ref={ref}
          id={areaId}
          rows={rows}
          required={required}
          aria-invalid={error ? true : undefined}
          className={cn(controlBase, controlBorder(Boolean(error)), 'py-1.5 leading-normal', className)}
          {...rest}
        />
      </Field>
    )
  },
)
