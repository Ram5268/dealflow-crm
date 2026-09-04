import { HintLabel } from './HintLabel'

/** Heading + blurb wrapper shared by every settings sub-page. */
export function SettingsPanel({
  title,
  blurb,
  children,
}: {
  title: string
  blurb: string
  children: React.ReactNode
}) {
  return (
    <div className="mx-auto max-w-2xl px-4 py-5">
      <header className="mb-4">
        <h2 className="text-3xl font-bold text-fg">{title}</h2>
        <p className="mt-1 text-base text-muted">{blurb}</p>
      </header>
      <div className="space-y-4">{children}</div>
    </div>
  )
}

export function SettingsCard({
  title,
  action,
  children,
  footer,
}: {
  title?: string
  action?: React.ReactNode
  children: React.ReactNode
  footer?: React.ReactNode
}) {
  return (
    <section className="rounded-lg border border-line bg-elevated">
      {(title || action) && (
        <header className="flex items-center justify-between gap-2 border-b border-line px-3 py-2">
          {title && <h3 className="text-base font-semibold text-fg">{title}</h3>}
          {action}
        </header>
      )}
      <div className="px-3 py-2">{children}</div>
      {footer && <div className="border-t border-line px-3 py-2 text-xs text-subtle">{footer}</div>}
    </section>
  )
}

/**
 * One label/value pair. `caption` states where the value comes from — every
 * read-only field on this surface says so, so nothing looks editable-but-broken.
 */
export function SettingsRow({
  label,
  value,
  caption,
  hint,
}: {
  label: string
  value: React.ReactNode
  caption?: string
  /** Tooltip on the label, e.g. "Env-configured". */
  hint?: string
}) {
  return (
    <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-0.5 py-1.5">
      <div className="min-w-0">
        <dt className="text-xs text-muted">
          {hint ? <HintLabel label={label} hint={hint} /> : label}
        </dt>
        {caption && <p className="mt-0.5 text-xs text-subtle">{caption}</p>}
      </div>
      <dd className="min-w-0 text-sm text-fg">{value}</dd>
    </div>
  )
}

/** Muted monospace for a configured-but-unset value. */
export function NotSet({ children = 'Not set' }: { children?: React.ReactNode }) {
  return <span className="text-subtle">{children}</span>
}
