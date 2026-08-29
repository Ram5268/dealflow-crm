'use client'

import { useEffect, useRef } from 'react'
import { useRouter } from 'next/navigation'
import {
  GO_TO_ROUTES,
  SEQUENCE_TIMEOUT_MS,
  isEditableTarget,
  isPaletteChord,
  isQuestionMark,
  isShortcutsChord,
} from '@/lib/ui/hotkeys'

/**
 * The app's single global key listener (brief §7 — no hotkey library).
 *
 * Two-key `g <key>` sequences are handled with a tiny armed-flag state machine
 * that lapses after SEQUENCE_TIMEOUT_MS, so a stray `g` never swallows the next
 * keystroke indefinitely.
 *
 * Chorded shortcuts (⌘K, ⌘/) fire even while typing — they are how you escape a
 * field. Bare keys (g, ?) are suppressed inside inputs so typing "g" in a search
 * box does not navigate.
 */
export function useGlobalHotkeys({
  onOpenPalette,
  onOpenShortcuts,
}: {
  onOpenPalette: () => void
  onOpenShortcuts: () => void
}) {
  const router = useRouter()
  const goArmed = useRef(false)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    const disarm = () => {
      goArmed.current = false
      if (timer.current) {
        clearTimeout(timer.current)
        timer.current = null
      }
    }

    const onKeyDown = (e: KeyboardEvent) => {
      if (isPaletteChord(e)) {
        e.preventDefault()
        disarm()
        onOpenPalette()
        return
      }
      if (isShortcutsChord(e)) {
        e.preventDefault()
        disarm()
        onOpenShortcuts()
        return
      }

      // Everything below is a bare key — never hijack typing.
      if (isEditableTarget(e.target)) return

      if (isQuestionMark(e)) {
        e.preventDefault()
        disarm()
        onOpenShortcuts()
        return
      }

      if (goArmed.current) {
        const dest = GO_TO_ROUTES[e.key.toLowerCase()]
        disarm()
        if (dest) {
          e.preventDefault()
          router.push(dest)
        }
        return
      }

      if (e.key === 'g' && !e.metaKey && !e.ctrlKey && !e.altKey) {
        goArmed.current = true
        timer.current = setTimeout(disarm, SEQUENCE_TIMEOUT_MS)
      }
    }

    document.addEventListener('keydown', onKeyDown)
    return () => {
      document.removeEventListener('keydown', onKeyDown)
      disarm()
    }
  }, [router, onOpenPalette, onOpenShortcuts])
}
