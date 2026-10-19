'use client'

import { Modal } from '@/components/ui'
import { FILTER_HELP } from './filters'

/** "How these filters work": the field behind each filter, in plain English. */
export function FilterHelpTable() {
  return (
    <table className="w-full border-collapse text-sm">
      <thead>
        <tr className="text-left">
          <th className="w-40 border-b border-line py-1.5 pr-3 font-semibold text-fg">Filter</th>
          <th className="border-b border-line py-1.5 font-semibold text-fg">What it reads</th>
        </tr>
      </thead>
      <tbody>
        {FILTER_HELP.map((row) => (
          <tr key={row.filter} className="align-top">
            <td className="border-b border-line py-1.5 pr-3 font-medium text-fg">{row.filter}</td>
            <td className="border-b border-line py-1.5 text-muted">{row.reads}</td>
          </tr>
        ))}
      </tbody>
    </table>
  )
}

export function FilterHelpDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (o: boolean) => void }) {
  return (
    <Modal
      open={open}
      onOpenChange={onOpenChange}
      title="How these filters work"
      description="Each filter narrows the board and the table. Two or more filters together show only people who match all of them."
    >
      <div className="max-h-[60vh] overflow-y-auto">
        <FilterHelpTable />
      </div>
    </Modal>
  )
}
