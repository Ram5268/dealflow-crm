import { cn } from '@/lib/ui/cn'

export function EmptyState({
  icon,
  title,
  description,
  action,
  className,
}: {
  icon?: React.ReactNode
  title: string
  description?: string
  action?: React.ReactNode
  className?: string
}) {
  return (
    <div
      className={cn(
        'flex flex-col items-center justify-center gap-2 px-6 py-12 text-center',
        className,
      )}
    >
      {icon && <div className="text-subtle [&_svg]:h-8 [&_svg]:w-8">{icon}</div>}
      {/* 24px is Close's page/empty-state heading step; will consolidate into
          the type scale in PR-E. */}
      <p className="text-[24px] font-bold text-fg">{title}</p>
      {description && <p className="max-w-md text-base text-muted">{description}</p>}
      {action && <div className="mt-2">{action}</div>}
    </div>
  )
}
