'use client'

import { usePathname, useRouter } from 'next/navigation'
import { Bell, ChevronDown, Menu, Plus, Upload, UserPlus } from 'lucide-react'
import {
  Button,
  DropdownContent,
  DropdownItem,
  DropdownRoot,
  DropdownTrigger,
  IconButton,
} from '@/components/ui'
import { ALL_DESTINATIONS, isActivePath } from '@/lib/ui/nav'
import { SearchLauncher } from './SearchLauncher'

/** Longest matching destination label; falls back to a humanised first segment. */
function titleFor(pathname: string): string {
  const match = ALL_DESTINATIONS.filter((d) => isActivePath(pathname, d.href)).sort(
    (a, b) => b.href.length - a.href.length,
  )[0]
  if (match) return match.label
  const seg = pathname.split('/').filter(Boolean)[0]
  return seg ? seg[0].toUpperCase() + seg.slice(1) : 'DealFlow'
}

export function TopBar({ onOpenPalette, onOpenNav }: { onOpenPalette: () => void; onOpenNav?: () => void }) {
  const pathname = usePathname()
  const router = useRouter()

  return (
    <header
      style={{ height: 'var(--topbar-h)' }}
      className="flex shrink-0 items-center justify-between gap-2 border-b border-line-subtle bg-elevated pl-2 pr-2 md:gap-4 md:pl-6 md:pr-4"
    >
      {/* Brief 45: at phone width the sidebar (nav, lists, groups) opens from here. */}
      {onOpenNav && (
        <IconButton label="Open menu" onClick={onOpenNav} className="md:hidden" tooltip={false}>
          <Menu size={16} />
        </IconButton>
      )}
      <h1 className="min-w-0 max-w-[30%] truncate text-sm font-semibold text-fg-strong md:max-w-none md:shrink-0">
        {titleFor(pathname)}
      </h1>

      <SearchLauncher onOpenPalette={onOpenPalette} />

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
