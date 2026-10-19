'use client'

import { Kbd, Modal } from '@/components/ui'
import { chipKeysRangeLabel } from '@/components/lists/chip-keys'

export const SHORTCUT_GROUPS: { title: string; items: { keys: string[]; label: string }[] }[] = [
  {
    title: 'Global',
    items: [
      { keys: ['⌘', 'K'], label: 'Open command palette' },
      { keys: ['⌘', '/'], label: 'Show this sheet' },
      { keys: ['?'], label: 'Show this sheet' },
      { keys: ['Esc'], label: 'Close any overlay' },
    ],
  },
  {
    title: 'Go to',
    items: [
      { keys: ['g', 'f'], label: 'Focus' },
      { keys: ['g', 'i'], label: 'Inbox' },
      { keys: ['g', 'l'], label: 'Leads' },
      { keys: ['g', 's'], label: 'Sequences' },
      { keys: ['g', 'p'], label: 'Pipeline' },
    ],
  },
  {
    title: 'Tables (leads, lists)',
    items: [
      { keys: ['↑', '↓'], label: 'Move between rows' },
      { keys: ['Enter'], label: 'Open the focused row' },
      { keys: ['Space'], label: 'Select the focused row' },
    ],
  },
  {
    // Brief 45: folders, lists and groups in the sidebar. Every drag has a key.
    title: 'Sidebar (folders, lists, groups)',
    items: [
      { keys: ['↑', '↓'], label: 'Move between folders, lists and groups' },
      { keys: ['←', '→'], label: 'Close or open a folder' },
      { keys: ['F2'], label: 'Rename (or double-click)' },
      { keys: ['⇧', 'F10'], label: 'Open its menu (or right-click, or ⋯)' },
      { keys: ['⌥', '↑'], label: 'Move up' },
      { keys: ['⌥', '↓'], label: 'Move down' },
      { keys: ['Enter'], label: 'Save a new name' },
      { keys: ['Esc'], label: 'Cancel a new name' },
    ],
  },
  {
    // Brief 45 (PR C): the group chips on a lead's card (the lead page, list
    // rows, the dialer), while that card has focus and you're not typing.
    title: 'Contact card',
    items: [{ keys: [chipKeysRangeLabel()], label: 'Add or remove one of the first nine groups' }],
  },
  {
    // Brief 45: every drag on the Pipeline board has a key (src/app/pipeline/keys.ts).
    title: 'Pipeline',
    items: [
      { keys: ['↑', '↓', '←', '→'], label: 'Move between cards' },
      { keys: ['['], label: 'Move the card to the column on the left' },
      { keys: [']'], label: 'Move the card to the column on the right' },
      { keys: ['M'], label: 'Move the card to any group… (or ⇧F10)' },
      { keys: ['Enter'], label: 'Open the lead' },
      { keys: ['F2'], label: 'Rename the focused workflow tab' },
    ],
  },
]

export function ShortcutsSheet({
  open,
  onOpenChange,
}: {
  open: boolean
  onOpenChange: (o: boolean) => void
}) {
  return (
    <Modal open={open} onOpenChange={onOpenChange} title="Keyboard shortcuts">
      {/* Scrolls when the list outgrows a short screen (Brief 45 added the sidebar keys). */}
      <div className="flex max-h-[70vh] flex-col gap-4 overflow-y-auto">
        {SHORTCUT_GROUPS.map((g) => (
          <div key={g.title}>
            <p className="mb-1.5 text-xs font-medium text-subtle">{g.title}</p>
            <ul className="flex flex-col gap-1">
              {g.items.map((i) => (
                <li key={i.label + i.keys.join()} className="flex items-center justify-between">
                  <span className="text-sm text-fg">{i.label}</span>
                  <span className="flex items-center gap-1">
                    {i.keys.map((k) => (
                      <Kbd key={k}>{k}</Kbd>
                    ))}
                  </span>
                </li>
              ))}
            </ul>
          </div>
        ))}
      </div>
    </Modal>
  )
}
