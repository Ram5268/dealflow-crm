'use client'

import { usePathname, useRouter } from 'next/navigation'
import { Bell, ChevronDown, Plus, Upload, UserPlus } from 'lucide-react'
import {
  Button,
  DropdownContent,
  DropdownItem,
  DropdownRoot,
  DropdownTrigger,
  IconButton,
} from '@/components/ui'
import { ALL_DESTINATIONS, isActivePath } from '@/lib/ui/nav'

/** Longest matching destination label; falls back to a humanised first segment. */
function titleFor(pathname: string): string {
  const match = ALL_DESTINATIONS.filter((d) => isActivePath(pathname, d.href)).sort(
    (a, b) => b.href.length - a.href.length,
  )[0]
  if (match) return match.label
  const seg = pathname.split('/').filter(Boolean)[0]
  return seg ? seg[0].toUpperCase() + seg.slice(1) : 'DealFlow'
}

export function TopBar() {
  const pathname = usePathname()
  const router = useRouter()

  return (
    <header
      style={{ height: 'var(--topbar-h)' }}
      className="flex shrink-0 items-center justify-between gap-4 border-b border-line bg-bg px-4"
    >
      <h1 className="min-w-0 truncate text-sm font-semibold text-fg">{titleFor(pathname)}</h1>

      <div className="flex shrink-0 items-center gap-1">
        {/* Notifications land in M3; the control is present but inert so the
            chrome does not shift when it goes live. */}
        <IconButton label="No notifications" disabled>
          <Bell size={15} />
        </IconButton>

        <DropdownRoot>
          <DropdownTrigger asChild>
            <Button variant="secondary" size="sm">
              <Plus size={13} />
              New
              <ChevronDown size={12} className="text-subtle" />
            </Button>
          </DropdownTrigger>
          <DropdownContent>
            <DropdownItem onSelect={() => router.push('/leads?new=1')}>
              <span className="flex items-center gap-2">
                <UserPlus size={13} className="text-subtle" />
                New Lead
              </span>
            </DropdownItem>
            <DropdownItem onSelect={() => router.push('/imports')}>
              <span className="flex items-center gap-2">
                <Upload size={13} className="text-subtle" />
                Import CSV
              </span>
            </DropdownItem>
          </DropdownContent>
        </DropdownRoot>
      </div>
    </header>
  )
}
