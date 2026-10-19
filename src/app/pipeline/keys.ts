// Brief 45 PR D — the Pipeline board's keys. Every drag has a keyboard
// alternative [brief §7]; all of them are listed in ShortcutsSheet.
//   ↑ ↓ ← →   move between cards (on a focused card)
//   [ / ]     move the card to the column on the left / right
//   M         "Move to group…" (any group, including ones not shown); also
//             Shift+F10 and the context-menu key
//   Enter     open the lead
// None of these is a global hotkey (useGlobalHotkeys: ⌘K, ⌘/, ?, g …), and
// none fires while typing or with ⌘ / Ctrl / Option held.
import type { KeyEventLike } from '@/lib/ui/hotkeys'

export type CardKeyAction =
  | { type: 'move'; dir: -1 | 1 }
  | { type: 'menu' }
  | { type: 'focus'; within: 'column' | 'row'; delta: -1 | 1 }
  | { type: 'open' }

/**
 * `onCard`: the card itself has focus (not one of its buttons), so arrows and
 * Enter belong to the board. `editable`: focus is in a text field.
 */
export function cardKeyAction(e: KeyEventLike, where: { onCard: boolean; editable: boolean }): CardKeyAction | null {
  if (where.editable || e.metaKey || e.ctrlKey || e.altKey) return null
  if (e.key === '[') return { type: 'move', dir: -1 }
  if (e.key === ']') return { type: 'move', dir: 1 }
  if (e.key === 'm' || e.key === 'M' || e.key === 'ContextMenu' || (e.key === 'F10' && e.shiftKey)) return { type: 'menu' }
  if (!where.onCard) return null
  switch (e.key) {
    case 'ArrowDown':
      return { type: 'focus', within: 'column', delta: 1 }
    case 'ArrowUp':
      return { type: 'focus', within: 'column', delta: -1 }
    case 'ArrowRight':
      return { type: 'focus', within: 'row', delta: 1 }
    case 'ArrowLeft':
      return { type: 'focus', within: 'row', delta: -1 }
    case 'Enter':
      return { type: 'open' }
    default:
      return null
  }
}
