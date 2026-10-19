// Brief 45 PR C — keys 1–9 toggle the first nine groups on a contact card
// while the card has focus [brief §5.3]. Pure, so it is tested without a page.
//
// Bare digits [decision recorded in the PR]: nothing in the CRM binds a bare
// digit anywhere a contact card can have focus. The global layer has ⌘K, ⌘/,
// ? and the g-sequences (useGlobalHotkeys); the Inbox has j/k/Enter/r/e/u/Esc
// and has no contact card; tables have arrows/Enter/Space; the dialer has no
// key bindings (its keypad is click-only). The brief's fallback, Option+1–9,
// is one constant away (CHIP_KEY_MODE) if a clash ever appears.
//
// Never inside a text field, never with ⌘/Ctrl (they switch browser tabs),
// never on a held-down key.

export type ChipKeyMode = 'digits' | 'option-digits'
export const CHIP_KEY_MODE: ChipKeyMode = 'digits'

/** Only the first nine groups have a key. */
export const CHIP_KEY_COUNT = 9

export interface ChipKeyInput {
  key: string
  /** The physical key ("Digit3"), needed for Option+digit: macOS types ¡™£… with Option. */
  code?: string
  metaKey: boolean
  ctrlKey: boolean
  altKey: boolean
  shiftKey: boolean
  repeat?: boolean
  isComposing?: boolean
  defaultPrevented?: boolean
}

export interface ChipKeyContext {
  /** Focus is in a text field (input, textarea, select, contenteditable). */
  editable: boolean
  /** Focus is inside this contact card. */
  inCard: boolean
  /** Nothing has focus, and this card is the page's own card (the lead page). */
  pageFocus: boolean
}

const PHYSICAL_DIGIT = /^(?:Digit|Numpad)([1-9])$/

/** Which chip (0–8) a key press toggles, or null when it isn't a chip key here. */
export function chipKeyIndex(e: ChipKeyInput, ctx: ChipKeyContext, mode: ChipKeyMode = CHIP_KEY_MODE): number | null {
  if (e.repeat || e.isComposing || e.defaultPrevented) return null
  if (ctx.editable || !(ctx.inCard || ctx.pageFocus)) return null
  if (e.metaKey || e.ctrlKey) return null
  let digit: string | undefined
  if (mode === 'digits') {
    // Shift is allowed: a US keyboard types "!" with Shift+1 (no match), and
    // layouts such as AZERTY need Shift to type a digit at all.
    if (e.altKey) return null
    digit = /^[1-9]$/.test(e.key) ? e.key : undefined
  } else {
    if (!e.altKey || e.shiftKey) return null
    digit = PHYSICAL_DIGIT.exec(e.code ?? '')?.[1]
  }
  return digit ? Number(digit) - 1 : null
}

/** The group a key press toggles (groups in sidebar order), or null. */
export function groupForKey<G>(e: ChipKeyInput, ctx: ChipKeyContext, groups: readonly G[], mode: ChipKeyMode = CHIP_KEY_MODE): G | null {
  const i = chipKeyIndex(e, ctx, mode)
  return i === null || i >= CHIP_KEY_COUNT ? null : (groups[i] ?? null)
}

/** The key for the chip at `index` ("1" … "9", or "⌥1" … "⌥9"); null past the ninth. */
export function chipKeyLabel(index: number, mode: ChipKeyMode = CHIP_KEY_MODE): string | null {
  if (!Number.isInteger(index) || index < 0 || index >= CHIP_KEY_COUNT) return null
  return `${mode === 'option-digits' ? '⌥' : ''}${index + 1}`
}

/** "1–9" (or "⌥1–⌥9"), for the shortcuts sheet. */
export function chipKeysRangeLabel(mode: ChipKeyMode = CHIP_KEY_MODE): string {
  return `${chipKeyLabel(0, mode)}–${chipKeyLabel(CHIP_KEY_COUNT - 1, mode)}`
}
