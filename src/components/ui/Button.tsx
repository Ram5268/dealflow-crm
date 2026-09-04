'use client'

import { forwardRef } from 'react'
import { Slot } from '@radix-ui/react-slot'
import { cn } from '@/lib/ui/cn'
import { Spinner } from './Spinner'

export type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger'
export type ButtonSize = 'sm' | 'md' | 'lg'

const VARIANTS: Record<ButtonVariant, string> = {
  primary:
    'bg-accent text-accent-fg border border-transparent hover:bg-accent-hover disabled:hover:bg-accent',
  secondary:
    'bg-elevated text-fg border border-line hover:bg-hover disabled:hover:bg-elevated',
  ghost:
    'bg-transparent text-muted border border-transparent hover:bg-hover hover:text-fg disabled:hover:bg-transparent',
  danger:
    'bg-danger text-danger-fg border border-transparent hover:opacity-90 disabled:hover:opacity-100',
}

// Dense by design (brief §6): 28 / 32 / 36px tall, not consumer 44+.
//
// Close runs two button label steps, both measured off app.close.com: its
// 32px buttons are 14px, its 24px ones 13px. `md` is our 32px, so it takes
// 14px and `lg` follows it; `sm` is 28px and sits nearer Close's small step,
// so it takes 13px rather than 14. That keeps the scale Close actually has
// instead of flattening all three to one size.
const SIZES: Record<ButtonSize, string> = {
  sm: 'h-7 px-2 text-sm gap-1',
  md: 'h-8 px-3 text-base gap-1.5',
  lg: 'h-9 px-4 text-base gap-2',
}

export interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant
  size?: ButtonSize
  loading?: boolean
  asChild?: boolean
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant = 'secondary', size = 'md', loading, asChild, className, children, disabled, ...rest },
  ref,
) {
  const Comp = asChild ? Slot : 'button'
  return (
    <Comp
      ref={ref}
      // `loading` implies disabled so a double-submit is impossible.
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      className={cn(
        'inline-flex shrink-0 items-center justify-center rounded-md font-medium',
        'transition-colors duration-100',
        'disabled:cursor-not-allowed disabled:opacity-50',
        VARIANTS[variant],
        SIZES[size],
        className,
      )}
      {...rest}
    >
      {loading ? (
        // Keep the label mounted but invisible so the button does not resize
        // mid-action (brief §6: "preserve width").
        <span className="relative inline-flex items-center justify-center">
          <span className="invisible contents">{children}</span>
          <Spinner className="absolute" />
        </span>
      ) : (
        children
      )}
    </Comp>
  )
})
