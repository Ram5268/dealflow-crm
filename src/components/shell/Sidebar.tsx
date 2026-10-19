'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { Suspense, useEffect, useState } from 'react'
import { PRIMARY_NAV, SETTINGS_NAV, isActivePath, type NavItem } from '@/lib/ui/nav'
import { cn } from '@/lib/ui/cn'
import { SidebarLists } from '@/components/lists/sidebar/SidebarLists'
import type { CreateRequest } from '@/components/lists/sidebar/createRequest'
import { UserMenu } from './UserMenu'

/** How often the sidebar badge re-checks. Deliberately slow: the number is
 *  ambient, and the inbox refreshes it immediately on any read/archive. */
const UNREAD_POLL_MS = 30_000

/** Live unread count for the Inbox badge. Silent on failure — a broken badge
 *  must never break the shell. */
function useUnreadCount(): number | null {
  const [count, setCount] = useState<number | null>(null)
  const pathname = usePathname()

  useEffect(() => {
    let cancelled = false
    const load = () => {
      fetch('/api/comms/messages/unread-count')
        .then((r) => (r.ok ? r.json() : null))
        .then((d) => {
          if (!cancelled && d && typeof d.count === 'number') setCount(d.count)
        })
        .catch(() => {})
    }
    load()
    const id = setInterval(load, UNREAD_POLL_MS)
    return () => {
      cancelled = true
      clearInterval(id)
    }
    // Re-reads on navigation too, so marking a thread read updates the badge
    // without waiting out the poll interval.
  }, [pathname])

  return count
}

function NavLink({ item, active, badge }: { item: NavItem; active: boolean; badge?: number | null }) {
  return (
    <Link
      href={item.href}
      aria-current={active ? 'page' : undefined}
      className={cn(
        // 30px rows, 8px radius, 12px right pad — measured off Close.
        'group flex h-[30px] items-center gap-2 rounded-md py-1 pl-2 pr-3',
        'text-sm font-medium transition-colors',
        // Close keeps every row at weight 500 and near-black; only the fill and
        // a half-shade of text separate active from idle.
        active
          ? 'bg-active text-fg-strong'
          : 'text-fg hover:bg-hover hover:text-fg-strong',
      )}
    >
      <item.icon size={14} className="shrink-0" />
      <span className="min-w-0 flex-1 truncate">{item.label}</span>
      {badge != null && badge > 0 && (
        <span className="shrink-0 rounded bg-accent px-1 text-[10px] font-medium text-accent-fg">
          {badge > 99 ? '99+' : badge}
        </span>
      )}
    </Link>
  )
}

export interface SidebarProps {
  displayName: string
  /** Brief 45: "New list / folder / group" from ⌘K, for this sidebar. */
  createRequest?: CreateRequest | null
  onCreateHandled?: () => void
}

/**
 * Everything in the sidebar: the brand, the main nav, then (Brief 45) the
 * Mojo-style All leads / Lists / Groups, then Settings and the user menu.
 * Shown as the left column on wider screens and inside the drawer at phone
 * width (AppShell).
 */
export function SidebarBody({ displayName, createRequest, onCreateHandled }: SidebarProps) {
  const pathname = usePathname()
  const unread = useUnreadCount()

  return (
    <>
      <div className="flex h-14 shrink-0 items-center px-4">
        <span className="text-sm font-semibold tracking-tight text-fg-strong">DealFlow</span>
      </div>

      <nav aria-label="Main" className="flex min-h-0 flex-1 flex-col overflow-y-auto px-2 pb-3">
        <div className="flex flex-col gap-0.5">
          {PRIMARY_NAV.map((item) => (
            <NavLink
              key={item.href}
              item={item}
              active={isActivePath(pathname, item.href)}
              badge={item.badge === 'inbox-unread' ? unread : undefined}
            />
          ))}
        </div>
        {/* Brief 45: folders, lists and groups, Mojo-style (brief §5.2). Suspense:
            it reads the URL (?groups=, ?wf=, ?group=) to mark the group or
            workflow being viewed. */}
        <Suspense fallback={null}>
          <SidebarLists createRequest={createRequest} onCreateHandled={onCreateHandled} />
        </Suspense>
      </nav>

      <div className="shrink-0 border-t border-line p-2">
        <NavLink item={SETTINGS_NAV} active={isActivePath(pathname, SETTINGS_NAV.href)} />
        <UserMenu displayName={displayName} />
      </div>
    </>
  )
}

export function Sidebar(props: SidebarProps) {
  return (
    // Below the md breakpoint the sidebar lives in a drawer opened from the top bar (Brief 45).
    <aside style={{ width: 'var(--sidebar-w)' }} className="hidden shrink-0 flex-col bg-bg md:flex">
      <SidebarBody {...props} />
    </aside>
  )
}
