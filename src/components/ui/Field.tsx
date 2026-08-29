import { cn } from '@/lib/ui/cn'

export interface FieldProps {
  label?: string
  hint?: string
  error?: string
  htmlFor?: string
  required?: boolean
  className?: string
  children: React.ReactNode
}

/** Shared label / hint / error chrome for form controls. */
export function Field({
  label,
  hint,
  error,
  htmlFor,
  required,
  className,
  children,
}: FieldProps) {
  return (
    <div className={cn('flex flex-col gap-1', className)}>
      {label && (
        <label htmlFor={htmlFor} className="text-xs font-medium text-muted">
          {label}
          {required && <span className="ml-0.5 text-danger">*</span>}
        </label>
      )}
      {children}
      {/* Error supersedes hint — never show both, it doubles the reading cost. */}
      {error ? (
        <p className="text-xs text-danger">{error}</p>
      ) : hint ? (
        <p className="text-xs text-subtle">{hint}</p>
      ) : null}
    </div>
  )
}

export const controlBase = cn(
  'w-full rounded-md border bg-elevated px-2 text-sm text-fg',
  'placeholder:text-subtle',
  'transition-colors duration-100',
  'disabled:cursor-not-allowed disabled:opacity-50',
)

export function controlBorder(hasError?: boolean) {
  return hasError ? 'border-danger' : 'border-line hover:border-line-strong'
}
