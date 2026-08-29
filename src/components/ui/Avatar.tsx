import { cn } from '@/lib/ui/cn'

/** Derive up to two initials. Falls back to '?' for empty/whitespace names. */
export function initialsOf(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean)
  if (parts.length === 0) return '?'
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase()
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase()
}

/** Initials-only by default — no external image fetch (brief §6). */
export function Avatar({
  name,
  size = 24,
  className,
}: {
  name: string
  size?: number
  className?: string
}) {
  return (
    <span
      aria-hidden="true"
      style={{ width: size, height: size, fontSize: Math.max(9, Math.round(size * 0.4)) }}
      className={cn(
        'inline-flex shrink-0 items-center justify-center rounded-full',
        'bg-accent-subtle font-medium text-accent select-none',
        className,
      )}
    >
      {initialsOf(name)}
    </span>
  )
}
