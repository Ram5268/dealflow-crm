import { cn } from '@/lib/ui/cn'

export function Skeleton({ className }: { className?: string }) {
  return (
    <div
      aria-hidden="true"
      className={cn('animate-pulse rounded bg-hover', className)}
    />
  )
}
