/** Pure helpers for the global hotkey layer — unit-testable without a DOM. */

/** True when keystrokes belong to the focused control, not the app. */
export function isEditableTarget(el: EventTarget | null): boolean {
  if (!(el instanceof HTMLElement)) return false
  const tag = el.tagName
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true
  return el.isContentEditable
}

export interface KeyEventLike {
  key: string
  metaKey: boolean
  ctrlKey: boolean
  altKey: boolean
  shiftKey: boolean
}

/** ⌘K on macOS, Ctrl+K elsewhere — accept either so it works on both. */
export function isPaletteChord(e: KeyEventLike): boolean {
  return (e.metaKey || e.ctrlKey) && !e.altKey && e.key.toLowerCase() === 'k'
}

/** ⌘/ or Ctrl+/ opens the shortcuts sheet. */
export function isShortcutsChord(e: KeyEventLike): boolean {
  return (e.metaKey || e.ctrlKey) && !e.altKey && e.key === '/'
}

/** Bare `?` — the alternate shortcuts binding (brief §7). */
export function isQuestionMark(e: KeyEventLike): boolean {
  return !e.metaKey && !e.ctrlKey && !e.altKey && e.key === '?'
}

/** The `g <key>` go-to sequence. */
export const GO_TO_ROUTES: Record<string, string> = {
  i: '/inbox',
  l: '/leads',
  f: '/',
  s: '/sequences',
}

/** How long a pending `g` stays armed before it lapses. */
export const SEQUENCE_TIMEOUT_MS = 1200
