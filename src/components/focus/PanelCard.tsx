import Link from 'next/link'
import { cn } from '@/lib/ui/cn'

/**
 * Shared shell for a Focus panel: a labelled count with up to three preview
 * rows beneath. Presentational and server-safe — panels stay Server Components.
 */
export function PanelCard({
  label,
  icon,
  count,
  countSuffix,
  href,
  hrefLabel,
  action,
  children,
}: {
  label: string
  icon: React.ReactNode
  count: number | string
  /** e.g. "+" when the number is limit-capped. */
  countSuffix?: string
  href?: string
  hrefLabel?: string
  action?: React.ReactNode
  children?: React.ReactNode
}) {
  return (
    <section className="flex flex-col rounded-lg border border-line bg-elevated">
      <header className="flex items-start justify-between gap-2 px-3 pb-2 pt-3">
        <div className="min-w-0">
          <div className="flex items-center gap-1.5 text-xs font-medium text-muted">
            <span className="text-subtle [&_svg]:h-3.5 [&_svg]:w-3.5">{icon}</span>
            <span className="truncate">{label}</span>
          </div>
          <p className="mt-1 text-2xl font-semibold leading-none tracking-tight text-fg">
            {count}
            {countSuffix && <span className="text-lg text-subtle">{countSuffix}</span>}
          </p>
        </div>
        {action}
      </header>

      <div className="min-h-0 flex-1 px-3 pb-2">{children}</div>

      {href && (
        <Link
          href={href}
          className={cn(
            'border-t border-line px-3 py-1.5 text-xs text-muted',
            'hover:bg-hover hover:text-fg',
          )}
        >
          {hrefLabel ?? 'View all'}
        </Link>
      )}
    </section>
  )
}

/** One preview line inside a panel. */
export function PanelRow({
  primary,
  secondary,
  trailing,
  href,
}: {
  primary: string
  secondary?: string
  trailing?: React.ReactNode
  href?: string
}) {
  const body = (
    <>
      <span className="min-w-0 flex-1 truncate">
        <span className="text-fg">{primary}</span>
        {secondary && <span className="ml-1.5 text-subtle">{secondary}</span>}
      </span>
      {trailing && <span className="shrink-0">{trailing}</span>}
    </>
  )
  const className = cn(
    'flex items-center gap-2 rounded px-1 py-1 text-xs',
    href && 'hover:bg-hover',
  )
  return href ? (
    <Link href={href} className={className}>
      {body}
    </Link>
  ) : (
    <div className={className}>{body}</div>
  )
}

/** Muted filler when a panel has a zero count. */
export function PanelEmpty({ children }: { children: React.ReactNode }) {
  return <p className="px-1 py-1 text-xs text-subtle">{children}</p>
}
