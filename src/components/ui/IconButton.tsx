'use client'

import { forwardRef } from 'react'
import { cn } from '@/lib/ui/cn'
import { Tooltip } from './Tooltip'

export interface IconButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  /** Required: icon-only controls must still be nameable by a screen reader. */
  label: string
  size?: 'sm' | 'md'
  /** Set false for controls whose meaning is already obvious in context. */
  tooltip?: boolean
}

export const IconButton = forwardRef<HTMLButtonElement, IconButtonProps>(
  function IconButton({ label, size = 'md', tooltip = true, className, children, ...rest }, ref) {
    const btn = (
      <button
        ref={ref}
        type="button"
        aria-label={label}
        className={cn(
          'inline-flex shrink-0 items-center justify-center rounded-md',
          'text-muted transition-colors duration-100',
          'hover:bg-hover hover:text-fg',
          'disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:bg-transparent',
          size === 'sm' ? 'h-7 w-7' : 'h-8 w-8',
          className,
        )}
        {...rest}
      >
        {children}
      </button>
    )
    return tooltip ? <Tooltip content={label}>{btn}</Tooltip> : btn
  },
)
