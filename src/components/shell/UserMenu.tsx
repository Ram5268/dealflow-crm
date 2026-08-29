'use client'

import { Check, ChevronsUpDown, LogOut, Monitor, Moon, Sun } from 'lucide-react'
import {
  Avatar,
  DropdownContent,
  DropdownItem,
  DropdownLabel,
  DropdownRoot,
  DropdownSeparator,
  DropdownTrigger,
  Tooltip,
} from '@/components/ui'
import { useTheme } from '@/components/theme/ThemeProvider'
import type { Theme } from '@/lib/ui/theme'
import { cn } from '@/lib/ui/cn'

const THEMES: { value: Theme; label: string; icon: typeof Sun }[] = [
  { value: 'system', label: 'System', icon: Monitor },
  { value: 'light', label: 'Light', icon: Sun },
  { value: 'dark', label: 'Dark', icon: Moon },
]

export function UserMenu({ displayName }: { displayName: string }) {
  const { theme, setTheme } = useTheme()

  return (
    <DropdownRoot>
      <DropdownTrigger asChild>
        <button
          type="button"
          className={cn(
            'flex h-10 w-full items-center gap-2 rounded-md px-2',
            'text-left transition-colors hover:bg-hover',
          )}
        >
          <Avatar name={displayName} size={22} />
          <span className="min-w-0 flex-1 truncate text-sm text-fg">{displayName}</span>
          <ChevronsUpDown size={13} className="shrink-0 text-subtle" />
        </button>
      </DropdownTrigger>
      <DropdownContent align="start" className="w-52">
        <DropdownLabel>Theme</DropdownLabel>
        {THEMES.map((t) => (
          <DropdownItem
            key={t.value}
            onSelect={() => setTheme(t.value)}
            shortcut={theme === t.value ? <Check size={13} className="text-accent" /> : undefined}
          >
            <span className="flex items-center gap-2">
              <t.icon size={13} className="text-subtle" />
              {t.label}
            </span>
          </DropdownItem>
        ))}
        <DropdownSeparator />
        {/* TODO: auth wiring — no session layer exists yet (brief §1). */}
        <Tooltip content="Auth pending" side="right">
          <div>
            <DropdownItem disabled>
              <span className="flex items-center gap-2">
                <LogOut size={13} className="text-subtle" />
                Sign out
              </span>
            </DropdownItem>
          </div>
        </Tooltip>
      </DropdownContent>
    </DropdownRoot>
  )
}
