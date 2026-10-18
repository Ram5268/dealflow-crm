'use client'

import { Command } from 'cmdk'
import * as RD from '@radix-ui/react-dialog'
import { useRouter } from 'next/navigation'
import { useCallback, useEffect, useRef, useState } from 'react'
import { ChevronLeft, FileText, FolderPlus, ListPlus, Mail, SquareKanban, Tag, Upload, UserPlus, Zap, List as ListIcon, type LucideIcon } from 'lucide-react'
import { ALL_DESTINATIONS } from '@/lib/ui/nav'
import { cn } from '@/lib/ui/cn'
import { groupColorStyle } from '@/lib/ui/groupColors'
import { useSidebarData } from '@/lib/core-data/lists/client'
import { formatCount } from '@/components/lists/format'
import { LIST_PALETTE_COMMANDS, paletteGroupEntries, paletteListEntries, type ListPaletteCommand } from '@/components/lists/sidebar/palette'
import type { CreateKind } from '@/components/lists/sidebar/createRequest'

/**
 * Primary actions (M6 §5). Every href here is a surface that actually exists —
 * `/leads?new=1` was a dead link until M6 gave it a modal, and "Compose email"
 * needed `/inbox?compose=1` because the reply drawer is thread-scoped and
 * cannot start a conversation.
 */
export const PALETTE_ACTIONS = [
  { id: 'new-lead', label: 'New lead', icon: UserPlus, href: '/leads?new=1' },
  { id: 'compose-email', label: 'Compose email', icon: Mail, href: '/inbox?compose=1' },
  { id: 'new-sequence', label: 'New sequence', icon: Zap, href: '/sequences/new' },
  { id: 'new-template', label: 'New template', icon: FileText, href: '/templates/new' },
  { id: 'import-csv', label: 'Import CSV', icon: Upload, href: '/imports' },
  // Brief 45 §5.2: the Pipeline (also under "Go to" as Pipeline, g p).
  { id: 'open-pipeline', label: 'Open Pipeline', icon: SquareKanban, href: '/pipeline' },
]

// Brief 45: folders, lists and groups (brief §5.2). "Go to …" open a page of
// the palette; "New …" open the sidebar's name box.
const LIST_COMMAND_ICONS: Record<string, LucideIcon> = {
  'go-list': ListIcon,
  'go-group': Tag,
  'new-list': ListPlus,
  'new-folder': FolderPlus,
  'new-group': Tag,
}
const GO_COMMANDS = LIST_PALETTE_COMMANDS.filter((c): c is Extract<ListPaletteCommand, { page: string }> => 'page' in c)
const CREATE_COMMANDS = LIST_PALETTE_COMMANDS.filter((c): c is Extract<ListPaletteCommand, { create: string }> => 'create' in c)

type Page = 'root' | 'lists' | 'groups'

/**
 * Close sets palette group headings at 11px/600 uppercase — the only place it
 * uses 11px at all. Everything else on the small-label step is --text-xs (12px),
 * so this size stays explicit rather than fighting the token.
 */
const GROUP_HEADING =
  '[&_[cmdk-group-heading]]:px-3 [&_[cmdk-group-heading]]:py-1.5 ' +
  '[&_[cmdk-group-heading]]:text-[11px] [&_[cmdk-group-heading]]:font-semibold ' +
  '[&_[cmdk-group-heading]]:uppercase [&_[cmdk-group-heading]]:text-subtle'

const ITEM = cn(
  'flex h-[34px] cursor-default select-none items-center gap-2 rounded px-3',
  'text-base text-muted',
  'data-[selected=true]:bg-hover data-[selected=true]:text-fg',
)

/** ⌘K palette. Populated with every navigable page plus the top-level actions. */
export function CommandPalette({
  open,
  onOpenChange,
  onCreate,
}: {
  open: boolean
  onOpenChange: (o: boolean) => void
  /** Brief 45: open the sidebar's "new folder / list / group" name box. */
  onCreate?: (kind: CreateKind) => void
}) {
  const router = useRouter()
  const { data } = useSidebarData()
  const [page, setPage] = useState<Page>('root')
  const [search, setSearch] = useState('')
  // A "New …" command hands focus to the sidebar's name box, not back to where it was.
  const handingFocus = useRef(false)

  useEffect(() => {
    if (!open) {
      setPage('root')
      setSearch('')
    }
  }, [open])

  const go = useCallback(
    (href: string) => {
      onOpenChange(false)
      router.push(href)
    },
    [router, onOpenChange],
  )

  const openPage = (next: Page) => {
    setPage(next)
    setSearch('')
  }

  const create = (kind: CreateKind) => {
    handingFocus.current = true
    onOpenChange(false)
    onCreate?.(kind)
  }

  const lists = page === 'lists' ? paletteListEntries(data) : []
  const groups = page === 'groups' ? paletteGroupEntries(data) : []

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
          // On a list or group page, Esc goes back to the commands first.
          onEscapeKeyDown={(e) => {
            if (page !== 'root') {
              e.preventDefault()
              openPage('root')
            }
          }}
          onCloseAutoFocus={(e) => {
            if (handingFocus.current) e.preventDefault()
            handingFocus.current = false
          }}
          className={cn(
            'fixed left-1/2 top-[20vh] z-50 w-[min(674px,calc(100vw-2rem))] -translate-x-1/2',
            'overflow-hidden rounded-xl border border-line-subtle bg-overlay shadow-lg',
            'data-[state=open]:animate-[dfFadeIn_120ms_ease-out]',
          )}
        >
          <RD.Title className="sr-only">Command palette</RD.Title>
          <Command
            loop
            onKeyDown={(e) => {
              // Backspace on an empty search goes back to the commands.
              if (e.key === 'Backspace' && search === '' && page !== 'root') {
                e.preventDefault()
                openPage('root')
              }
            }}
          >
            <div className="flex items-center bg-active">
              {page !== 'root' && (
                <button
                  type="button"
                  aria-label="Back to all commands"
                  onClick={() => openPage('root')}
                  className="ml-2 flex h-7 shrink-0 items-center gap-1 rounded px-1.5 text-sm text-muted hover:bg-hover hover:text-fg"
                >
                  <ChevronLeft size={14} />
                  {page === 'lists' ? 'Lists' : 'Groups'}
                </button>
              )}
              <Command.Input
                autoFocus
                value={search}
                onValueChange={setSearch}
                placeholder={
                  page === 'lists' ? 'Go to list…' : page === 'groups' ? 'Go to group…' : 'Jump to a page or run an action…'
                }
                className={cn(
                  'h-11 w-full bg-active px-3',
                  'text-base text-fg outline-none placeholder:text-subtle',
                )}
              />
            </div>
            <Command.List className="max-h-80 overflow-y-auto p-2">
              <Command.Empty className="px-3 py-6 text-center text-base text-subtle">
                {page === 'lists' && lists.length === 0
                  ? 'No lists yet. Make one with + List in the sidebar.'
                  : page === 'groups' && groups.length === 0
                    ? 'No groups yet. Make one with + Group in the sidebar.'
                    : 'No matches.'}
              </Command.Empty>

              {page === 'root' && (
                <>
                  <Command.Group heading="Go to" className={GROUP_HEADING}>
                    {ALL_DESTINATIONS.map((d) => (
                      <Command.Item key={d.href} value={`${d.label} ${d.href}`} onSelect={() => go(d.href)} className={ITEM}>
                        <d.icon size={14} className="shrink-0 text-subtle" />
                        <span className="min-w-0 flex-1 truncate">{d.label}</span>
                        {/* The hotkey is worth teaching; the route is not. Falls
                            back to the path for destinations without one. */}
                        <span className="shrink-0 text-xs text-subtle">
                          {d.goKey ? `g ${d.goKey}` : d.href}
                        </span>
                      </Command.Item>
                    ))}
                    {GO_COMMANDS.map((c) => {
                      const Icon = LIST_COMMAND_ICONS[c.id]
                      return (
                        <Command.Item key={c.id} value={c.label} onSelect={() => openPage(c.page)} className={ITEM}>
                          <Icon size={14} className="shrink-0 text-subtle" />
                          <span className="min-w-0 flex-1 truncate">{c.label}</span>
                        </Command.Item>
                      )
                    })}
                  </Command.Group>

                  <Command.Group heading="Actions" className={GROUP_HEADING}>
                    {PALETTE_ACTIONS.map((a) => (
                      <Command.Item key={a.id} value={`${a.label} ${a.href}`} onSelect={() => go(a.href)} className={ITEM}>
                        <a.icon size={14} className="shrink-0 text-subtle" />
                        <span className="min-w-0 flex-1 truncate">{a.label}</span>
                      </Command.Item>
                    ))}
                    {CREATE_COMMANDS.map((c) => {
                      const Icon = LIST_COMMAND_ICONS[c.id]
                      return (
                        <Command.Item key={c.id} value={c.label} onSelect={() => create(c.create)} className={ITEM}>
                          <Icon size={14} className="shrink-0 text-subtle" />
                          <span className="min-w-0 flex-1 truncate">{c.label}</span>
                        </Command.Item>
                      )
                    })}
                  </Command.Group>
                </>
              )}

              {page === 'lists' && lists.length > 0 && (
                <Command.Group heading="Lists" className={GROUP_HEADING}>
                  {lists.map((l) => (
                    <Command.Item key={l.id} value={`${l.label} ${l.detail} ${l.id}`} onSelect={() => go(l.href)} className={ITEM}>
                      <ListIcon size={14} className="shrink-0 text-subtle" />
                      <span className="min-w-0 flex-1 truncate">
                        {l.label}
                        <span className="text-subtle"> · {l.detail}</span>
                      </span>
                      <span className="shrink-0 text-xs tabular-nums text-subtle">{formatCount(l.count)}</span>
                    </Command.Item>
                  ))}
                </Command.Group>
              )}

              {page === 'groups' && groups.length > 0 && (
                <Command.Group heading="Groups" className={GROUP_HEADING}>
                  {groups.map((g) => (
                    <Command.Item key={g.id} value={`${g.label} ${g.id}`} onSelect={() => go(g.href)} className={ITEM}>
                      <span aria-hidden="true" className="flex w-3.5 shrink-0 justify-center">
                        <span className={cn('h-2 w-2 rounded-full', groupColorStyle(g.color).dot)} />
                      </span>
                      <span className="min-w-0 flex-1 truncate">{g.label}</span>
                      <span className="shrink-0 text-xs tabular-nums text-subtle">{formatCount(g.count)}</span>
                    </Command.Item>
                  ))}
                </Command.Group>
              )}
            </Command.List>
          </Command>
        </RD.Content>
      </RD.Portal>
    </RD.Root>
  )
}
