'use client'

import { useCallback, useState } from 'react'
import { SideDrawer, ToastProvider, TooltipProvider } from '@/components/ui'
import { ThemeProvider } from '@/components/theme/ThemeProvider'
import { PHONE_QUERY, type CreateKind, type CreateRequest } from '@/components/lists/sidebar/createRequest'
import { CommandPalette } from './CommandPalette'
import { ShortcutsSheet } from './ShortcutsSheet'
import { Sidebar, SidebarBody } from './Sidebar'
import { SoftphoneBar } from './SoftphoneBar'
import { TopBar } from './TopBar'
import { useGlobalHotkeys } from './useGlobalHotkeys'

function ShellChrome({
  displayName,
  children,
}: {
  displayName: string
  children: React.ReactNode
}) {
  const [paletteOpen, setPaletteOpen] = useState(false)
  const [shortcutsOpen, setShortcutsOpen] = useState(false)
  // Brief 45: at phone width the sidebar is a drawer behind the top bar's menu button.
  const [navOpen, setNavOpen] = useState(false)
  // ⌘K "New list / folder / group" opens the name box in whichever sidebar is on screen.
  const [createRequest, setCreateRequest] = useState<(CreateRequest & { target: 'sidebar' | 'drawer' }) | null>(null)

  const openPalette = useCallback(() => setPaletteOpen(true), [])
  const openShortcuts = useCallback(() => setShortcutsOpen(true), [])
  useGlobalHotkeys({ onOpenPalette: openPalette, onOpenShortcuts: openShortcuts })

  const requestCreate = useCallback((kind: CreateKind) => {
    const phone = window.matchMedia(PHONE_QUERY).matches
    if (phone) setNavOpen(true)
    setCreateRequest({ kind, nonce: Date.now(), target: phone ? 'drawer' : 'sidebar' })
  }, [])
  const createHandled = useCallback(() => setCreateRequest(null), [])

  return (
    <div className="flex h-dvh overflow-hidden">
      <Sidebar
        displayName={displayName}
        createRequest={createRequest?.target === 'sidebar' ? createRequest : null}
        onCreateHandled={createHandled}
      />
      <div className="flex min-w-0 flex-1 flex-col">
        <TopBar onOpenPalette={openPalette} onOpenNav={() => setNavOpen(true)} />
        {/* Full-bleed: pages own their own padding (brief §7). */}
        <main className="min-h-0 flex-1 overflow-y-auto">{children}</main>
        <SoftphoneBar />
      </div>
      <SideDrawer
        open={navOpen}
        onOpenChange={setNavOpen}
        title="Menu"
        // Esc in a name box cancels the box, not the drawer.
        onEscapeKeyDown={(e) => {
          if ((e.target as HTMLElement | null)?.closest?.('[data-inline-name]')) e.preventDefault()
        }}
      >
        <div
          className="flex min-h-0 flex-1 flex-col"
          // Following any link closes the drawer (a list, a group, a page).
          onClickCapture={(e) => {
            if ((e.target as HTMLElement).closest('a[href]')) setNavOpen(false)
          }}
        >
          <SidebarBody
            displayName={displayName}
            createRequest={createRequest?.target === 'drawer' ? createRequest : null}
            onCreateHandled={createHandled}
          />
        </div>
      </SideDrawer>
      <CommandPalette open={paletteOpen} onOpenChange={setPaletteOpen} onCreate={requestCreate} />
      <ShortcutsSheet open={shortcutsOpen} onOpenChange={setShortcutsOpen} />
    </div>
  )
}

/**
 * Root client shell. Providers are mounted here rather than in layout.tsx so
 * the server layout stays a Server Component and pages keep RSC data access.
 */
export function AppShell({
  displayName,
  children,
}: {
  displayName: string
  children: React.ReactNode
}) {
  return (
    <ThemeProvider>
      <TooltipProvider>
        <ToastProvider>
          <ShellChrome displayName={displayName}>{children}</ShellChrome>
        </ToastProvider>
      </TooltipProvider>
    </ThemeProvider>
  )
}
