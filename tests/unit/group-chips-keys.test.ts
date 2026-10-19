import { describe, it, expect } from 'vitest'
import {
  CHIP_KEY_MODE,
  chipKeyIndex,
  chipKeyLabel,
  chipKeysRangeLabel,
  groupForKey,
  type ChipKeyContext,
  type ChipKeyInput,
} from '@/components/lists/chip-keys'
import { SHORTCUT_GROUPS } from '@/components/shell/ShortcutsSheet'

// Brief 45 PR C — keys 1–9 toggle the first nine groups while the contact card
// has focus [brief §5.3]. Bare digits are used because nothing else in the CRM
// binds them where a card can have focus (global g-sequences and ⌘ chords,
// Inbox j/k/r/e/u, the lists' arrows/Enter/Space; the dialer has no key
// bindings). Option+1–9 is kept ready as the fallback. Never inside a text field.

const key = (k: string, more: Partial<ChipKeyInput> = {}): ChipKeyInput => ({
  key: k,
  code: /^[0-9]$/.test(k) ? `Digit${k}` : undefined,
  metaKey: false,
  ctrlKey: false,
  altKey: false,
  shiftKey: false,
  ...more,
})
const IN_CARD: ChipKeyContext = { editable: false, inCard: true, pageFocus: false }

describe('which chip a key toggles', () => {
  it('uses bare digits by default', () => {
    expect(CHIP_KEY_MODE).toBe('digits')
  })

  it('1–9 are the first nine chips; 0 and letters are not chip keys', () => {
    for (let n = 1; n <= 9; n++) expect(chipKeyIndex(key(String(n)), IN_CARD)).toBe(n - 1)
    for (const k of ['0', 'a', 'g', 'j', 'Enter', ' ', 'ArrowDown', '!']) expect(chipKeyIndex(key(k), IN_CARD)).toBeNull()
  })

  it('the number pad works too', () => {
    expect(chipKeyIndex(key('4', { code: 'Numpad4' }), IN_CARD)).toBe(3)
  })

  it('leaves chords alone (⌘1–9 and Ctrl+1–9 switch browser tabs)', () => {
    for (const mod of ['metaKey', 'ctrlKey', 'altKey'] as const) {
      expect(chipKeyIndex(key('1', { [mod]: true }), IN_CARD)).toBeNull()
    }
    // Shift is not a chord here: a US keyboard types "!" with Shift+1 (no
    // match), and layouts such as AZERTY need Shift to type a digit at all.
    expect(chipKeyIndex(key('!', { code: 'Digit1', shiftKey: true }), IN_CARD)).toBeNull()
    expect(chipKeyIndex(key('1', { code: 'Digit1', shiftKey: true }), IN_CARD)).toBe(0)
  })

  it('ignores a held-down key, typing in an IME, and keys something else already handled', () => {
    expect(chipKeyIndex(key('1', { repeat: true }), IN_CARD)).toBeNull()
    expect(chipKeyIndex(key('1', { isComposing: true }), IN_CARD)).toBeNull()
    expect(chipKeyIndex(key('1', { defaultPrevented: true }), IN_CARD)).toBeNull()
  })

  it('never fires inside a text field', () => {
    expect(chipKeyIndex(key('1'), { editable: true, inCard: true, pageFocus: false })).toBeNull()
    expect(chipKeyIndex(key('1'), { editable: true, inCard: false, pageFocus: true })).toBeNull()
  })

  it('only while the card has focus: inside it, or (on the lead page) when nothing else has focus', () => {
    expect(chipKeyIndex(key('2'), { editable: false, inCard: false, pageFocus: false })).toBeNull()
    expect(chipKeyIndex(key('2'), { editable: false, inCard: true, pageFocus: false })).toBe(1)
    expect(chipKeyIndex(key('2'), { editable: false, inCard: false, pageFocus: true })).toBe(1)
  })

  it('Option+1–9 fallback: reads the physical key (macOS types ¡™£… with Option), and bare digits do nothing', () => {
    expect(chipKeyIndex(key('£', { code: 'Digit3', altKey: true }), IN_CARD, 'option-digits')).toBe(2)
    expect(chipKeyIndex(key('ª', { code: 'Digit9', altKey: true }), IN_CARD, 'option-digits')).toBe(8)
    expect(chipKeyIndex(key('9', { code: 'Numpad9', altKey: true }), IN_CARD, 'option-digits')).toBe(8)
    expect(chipKeyIndex(key('3'), IN_CARD, 'option-digits')).toBeNull()
    expect(chipKeyIndex(key('º', { code: 'Digit0', altKey: true }), IN_CARD, 'option-digits')).toBeNull()
    expect(chipKeyIndex(key('£', { code: 'Digit3', altKey: true, metaKey: true }), IN_CARD, 'option-digits')).toBeNull()
    expect(chipKeyIndex(key('£', { code: 'Digit3', altKey: true }), { editable: true, inCard: true, pageFocus: false }, 'option-digits')).toBeNull()
  })

  it('maps to the group in sidebar order; a key past the last group does nothing; a tenth group has no key', () => {
    const groups = Array.from({ length: 10 }, (_, i) => ({ id: `g${i + 1}`, name: `Group ${i + 1}` }))
    expect(groupForKey(key('1'), IN_CARD, groups)?.id).toBe('g1')
    expect(groupForKey(key('9'), IN_CARD, groups)?.id).toBe('g9')
    expect(groupForKey(key('4'), IN_CARD, groups.slice(0, 3))).toBeNull()
    expect(groupForKey(key('1'), IN_CARD, [])).toBeNull()
    expect(groupForKey(key('1'), { editable: true, inCard: true, pageFocus: false }, groups)).toBeNull()
  })

  it('labels the keys for the chips and the shortcuts sheet', () => {
    expect(chipKeyLabel(0)).toBe('1')
    expect(chipKeyLabel(8)).toBe('9')
    expect(chipKeyLabel(9)).toBeNull()
    expect(chipKeyLabel(2, 'option-digits')).toBe('⌥3')
    expect(chipKeysRangeLabel()).toBe('1–9')
    expect(chipKeysRangeLabel('option-digits')).toBe('⌥1–⌥9')
  })
})

describe('the shortcuts sheet', () => {
  it('lists the group keys under the contact card', () => {
    const card = SHORTCUT_GROUPS.find((g) => g.title === 'Contact card')
    expect(card).toBeDefined()
    expect(card!.items).toContainEqual({ keys: [chipKeysRangeLabel()], label: 'Add or remove one of the first nine groups' })
  })
})
