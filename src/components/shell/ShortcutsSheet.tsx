'use client'

import { Kbd, Modal } from '@/components/ui'

const GROUPS: { title: string; items: { keys: string[]; label: string }[] }[] = [
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
    ],
  },
  {
    title: 'Lists',
    items: [
      { keys: ['↑', '↓'], label: 'Move between rows' },
      { keys: ['Enter'], label: 'Open the focused row' },
      { keys: ['Space'], label: 'Select the focused row' },
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
      <div className="flex flex-col gap-4">
        {GROUPS.map((g) => (
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
