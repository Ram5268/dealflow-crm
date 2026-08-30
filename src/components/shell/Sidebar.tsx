'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { useEffect, useState } from 'react'
import { PRIMARY_NAV, SETTINGS_NAV, isActivePath, type NavItem } from '@/lib/ui/nav'
import { cn } from '@/lib/ui/cn'
import { UserMenu } from './UserMenu'

/** Live unread count for the Inbox badge. Silent on failure — a broken badge
 *  must never break the shell. */
function useUnreadCount(): number | null {
  const [count, setCount] = useState<number | null>(null)
  useEffect(() => {
    let cancelled = false
    fetch('/api/comms/messages/unread-count')
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        if (!cancelled && d && typeof d.count === 'number') setCount(d.count)
      })
      .catch(() => {})
    return () => {
      cancelled = true
    }
  }, [])
  return count
}

function NavLink({ item, active, badge }: { item: NavItem; active: boolean; badge?: number | null }) {
  return (
    <Link
      href={item.href}
      aria-current={active ? 'page' : undefined}
      className={cn(
        // 32px rows — dense on purpose (brief §6).
        'group flex h-8 items-center gap-2 rounded-md px-2 text-sm transition-colors',
        active ? 'bg-active font-medium text-fg' : 'text-muted hover:bg-hover hover:text-fg',
      )}
    >
      <item.icon size={15} className="shrink-0" />
      <span className="min-w-0 flex-1 truncate">{item.label}</span>
      {badge != null && badge > 0 && (
        <span className="shrink-0 rounded bg-accent px-1 text-[10px] font-medium text-accent-fg">
          {badge > 99 ? '99+' : badge}
        </span>
      )}
    </Link>
  )
}

export function Sidebar({ displayName }: { displayName: string }) {
  const pathname = usePathname()
  const unread = useUnreadCount()

  return (
    <aside
      style={{ width: 'var(--sidebar-w)' }}
      className="flex shrink-0 flex-col border-r border-line bg-bg"
    >
      <div className="flex h-12 shrink-0 items-center px-4">
        <span className="text-sm font-semibold tracking-tight text-fg">DealFlow</span>
      </div>

      <nav className="flex min-h-0 flex-1 flex-col gap-0.5 overflow-y-auto px-2">
        {PRIMARY_NAV.map((item) => (
          <NavLink
            key={item.href}
            item={item}
            active={isActivePath(pathname, item.href)}
            badge={item.badge === 'inbox-unread' ? unread : undefined}
          />
        ))}
      </nav>

      <div className="shrink-0 border-t border-line p-2">
        <NavLink item={SETTINGS_NAV} active={isActivePath(pathname, SETTINGS_NAV.href)} />
        <UserMenu displayName={displayName} />
      </div>
    </aside>
  )
}
