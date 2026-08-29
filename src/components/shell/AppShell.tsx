'use client'

import { useCallback, useState } from 'react'
import { ToastProvider, TooltipProvider } from '@/components/ui'
import { ThemeProvider } from '@/components/theme/ThemeProvider'
import { CommandPalette } from './CommandPalette'
import { ShortcutsSheet } from './ShortcutsSheet'
import { Sidebar } from './Sidebar'
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

  const openPalette = useCallback(() => setPaletteOpen(true), [])
  const openShortcuts = useCallback(() => setShortcutsOpen(true), [])
  useGlobalHotkeys({ onOpenPalette: openPalette, onOpenShortcuts: openShortcuts })

  return (
    <div className="flex h-dvh overflow-hidden">
      <Sidebar displayName={displayName} onOpenPalette={openPalette} />
      <div className="flex min-w-0 flex-1 flex-col">
        <TopBar onOpenPalette={openPalette} />
        {/* Full-bleed: pages own their own padding (brief §7). */}
        <main className="min-h-0 flex-1 overflow-y-auto">{children}</main>
        <SoftphoneBar />
      </div>
      <CommandPalette open={paletteOpen} onOpenChange={setPaletteOpen} />
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
