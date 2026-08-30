'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { cn } from '@/lib/ui/cn'
import { SETTINGS_SECTIONS, isActiveSettingsPath, settingsHref } from '@/lib/settings/nav'

/**
 * The settings left rail. A Client Component only for `usePathname` — every
 * sub-page itself stays a Server Component.
 */
export function SettingsRail() {
  const pathname = usePathname()

  return (
    <nav
      aria-label="Settings sections"
      className="shrink-0 border-b border-line py-3 sm:w-52 sm:border-b-0 sm:border-r"
    >
      <ul className="flex gap-1 overflow-x-auto px-2 sm:block sm:space-y-0.5 sm:overflow-visible">
        {SETTINGS_SECTIONS.map((section) => {
          const active = isActiveSettingsPath(pathname, section.slug)
          const Icon = section.icon
          return (
            <li key={section.slug}>
              <Link
                href={settingsHref(section.slug)}
                aria-current={active ? 'page' : undefined}
                className={cn(
                  'flex items-center gap-2 whitespace-nowrap rounded border-l-2 px-2 py-1.5 text-sm',
                  active
                    ? 'border-l-accent bg-accent-subtle font-medium text-fg'
                    : 'border-l-transparent text-muted hover:bg-hover hover:text-fg',
                )}
              >
                <Icon aria-hidden className="h-4 w-4 shrink-0 text-subtle" />
                <span className="truncate">{section.label}</span>
              </Link>
            </li>
          )
        })}
      </ul>
    </nav>
  )
}
