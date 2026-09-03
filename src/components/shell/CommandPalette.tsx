'use client'

import { Command } from 'cmdk'
import * as RD from '@radix-ui/react-dialog'
import { useRouter } from 'next/navigation'
import { useCallback } from 'react'
import { FileText, Mail, Upload, UserPlus, Zap } from 'lucide-react'
import { ALL_DESTINATIONS } from '@/lib/ui/nav'
import { cn } from '@/lib/ui/cn'

/**
 * Primary actions (M6 §5). Every href here is a surface that actually exists —
 * `/leads?new=1` was a dead link until M6 gave it a modal, and "Compose email"
 * needed `/inbox?compose=1` because the reply drawer is thread-scoped and
 * cannot start a conversation.
 */
const ACTIONS = [
  { id: 'new-lead', label: 'New lead', icon: UserPlus, href: '/leads?new=1' },
  { id: 'compose-email', label: 'Compose email', icon: Mail, href: '/inbox?compose=1' },
  { id: 'new-sequence', label: 'New sequence', icon: Zap, href: '/sequences/new' },
  { id: 'new-template', label: 'New template', icon: FileText, href: '/templates/new' },
  { id: 'import-csv', label: 'Import CSV', icon: Upload, href: '/imports' },
]

/**
 * Close sets palette group headings at 11px/600 uppercase — the only place it
 * uses 11px at all. Everything else on the small-label step is --text-xs (12px),
 * so this size stays explicit rather than fighting the token.
 */
const GROUP_HEADING =
  '[&_[cmdk-group-heading]]:px-3 [&_[cmdk-group-heading]]:py-1.5 ' +
  '[&_[cmdk-group-heading]]:text-[11px] [&_[cmdk-group-heading]]:font-semibold ' +
  '[&_[cmdk-group-heading]]:uppercase [&_[cmdk-group-heading]]:text-subtle'

/** ⌘K palette. Populated with every navigable page plus the top-level actions. */
export function CommandPalette({
  open,
  onOpenChange,
}: {
  open: boolean
  onOpenChange: (o: boolean) => void
}) {
  const router = useRouter()

  const go = useCallback(
    (href: string) => {
      onOpenChange(false)
      router.push(href)
    },
    [router, onOpenChange],
  )

  return (
    <RD.Root open={open} onOpenChange={onOpenChange}>
      <RD.Portal>
        <RD.Overlay
          className={cn(
            'fixed inset-0 z-40 bg-black/40',
            'data-[state=open]:animate-[dfFadeIn_120ms_ease-out]',
          )}
        />
        <RD.Content
          aria-label="Command palette"
          className={cn(
            'fixed left-1/2 top-[20vh] z-50 w-[min(674px,calc(100vw-2rem))] -translate-x-1/2',
            'overflow-hidden rounded-xl border border-line-subtle bg-overlay shadow-lg',
            'data-[state=open]:animate-[dfFadeIn_120ms_ease-out]',
          )}
        >
          <RD.Title className="sr-only">Command palette</RD.Title>
          <Command loop>
            <Command.Input
              autoFocus
              placeholder="Jump to a page or run an action…"
              className={cn(
                'h-11 w-full bg-active px-3',
                'text-base text-fg outline-none placeholder:text-subtle',
              )}
            />
            <Command.List className="max-h-80 overflow-y-auto p-2">
              <Command.Empty className="px-3 py-6 text-center text-base text-subtle">
                No matches.
              </Command.Empty>

              <Command.Group
                heading="Go to"
                className={GROUP_HEADING}
              >
                {ALL_DESTINATIONS.map((d) => (
                  <Command.Item
                    key={d.href}
                    value={`${d.label} ${d.href}`}
                    onSelect={() => go(d.href)}
                    className={cn(
                      'flex h-[34px] cursor-default select-none items-center gap-2 rounded px-3',
                      'text-base text-muted',
                      'data-[selected=true]:bg-hover data-[selected=true]:text-fg',
                    )}
                  >
                    <d.icon size={14} className="shrink-0 text-subtle" />
                    <span className="min-w-0 flex-1 truncate">{d.label}</span>
                    {/* The hotkey is worth teaching; the route is not. Falls
                        back to the path for destinations without one. */}
                    <span className="shrink-0 text-xs text-subtle">
                      {d.goKey ? `g ${d.goKey}` : d.href}
                    </span>
                  </Command.Item>
                ))}
              </Command.Group>

              <Command.Group
                heading="Actions"
                className={GROUP_HEADING}
              >
                {ACTIONS.map((a) => (
                  <Command.Item
                    key={a.id}
                    value={`${a.label} ${a.href}`}
                    onSelect={() => go(a.href)}
                    className={cn(
                      'flex h-[34px] cursor-default select-none items-center gap-2 rounded px-3',
                      'text-base text-muted',
                      'data-[selected=true]:bg-hover data-[selected=true]:text-fg',
                    )}
                  >
                    <a.icon size={14} className="shrink-0 text-subtle" />
                    <span className="min-w-0 flex-1 truncate">{a.label}</span>
                  </Command.Item>
                ))}
              </Command.Group>
            </Command.List>
          </Command>
        </RD.Content>
      </RD.Portal>
    </RD.Root>
  )
}
