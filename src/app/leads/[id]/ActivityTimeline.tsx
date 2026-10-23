'use client'

import { Pencil, Tag } from 'lucide-react'
import { GROUP_ACTIVITY_TYPE } from '@/lib/core-data/lists/timeline'
import { LEAD_EDIT_ACTIVITY_TYPE, editEntryLines } from '@/lib/core-data/leads/edit-text'

export interface ActivityItem {
  id: string
  type: string
  activityAt: string
  bodyText: string | null
}

const FMT = new Intl.DateTimeFormat('en-US', {
  month: 'short',
  day: 'numeric',
  hour: 'numeric',
  minute: '2-digit',
})

/** Client component so timestamps render in the viewer's locale/timezone rather
 *  than the server's. */
export function ActivityTimeline({ items }: { items: ActivityItem[] }) {
  return (
    <ul className="flex flex-col">
      {items.map((a) => {
        // Brief 50 PR 5: an edit made on the lead page reads "Edited", then
        // each change on its own line ("Name changed", "Phone added (…0123)").
        if (a.type === LEAD_EDIT_ACTIVITY_TYPE) return <EditEntry key={a.id} item={a} />
        // Brief 45 (PR C): a group change reads as its text, "Added to Hot ·
        // Oct 18, 3:42 PM", not as a "Group" entry. It's a label, not contact.
        const group = a.type === GROUP_ACTIVITY_TYPE
        return (
          <li key={a.id} className="border-l-2 border-line py-1.5 pl-3">
            <div className="flex items-baseline justify-between gap-2">
              {group ? (
                <span className="flex min-w-0 items-center gap-1.5 text-sm text-fg">
                  <Tag size={12} aria-hidden="true" className="shrink-0 text-subtle" />
                  {a.bodyText}
                </span>
              ) : (
                <span className="text-sm font-medium text-fg">{a.type}</span>
              )}
              <time dateTime={a.activityAt} className="shrink-0 text-xs text-subtle">
                {FMT.format(new Date(a.activityAt))}
              </time>
            </div>
            {!group && a.bodyText && <p className="mt-0.5 text-sm text-muted">{a.bodyText}</p>}
          </li>
        )
      })}
    </ul>
  )
}

function EditEntry({ item }: { item: ActivityItem }) {
  const lines = editEntryLines(item.bodyText)
  return (
    <li className="border-l-2 border-line py-1.5 pl-3">
      <div className="flex items-baseline justify-between gap-2">
        <span className="flex min-w-0 items-center gap-1.5 text-sm font-medium text-fg">
          <Pencil size={12} aria-hidden="true" className="shrink-0 text-subtle" />
          Edited
        </span>
        <time dateTime={item.activityAt} className="shrink-0 text-xs text-subtle">
          {FMT.format(new Date(item.activityAt))}
        </time>
      </div>
      {lines.length > 0 && (
        <ul className="mt-0.5 flex flex-col">
          {lines.map((line, i) => (
            <li key={i} className="break-words text-sm text-muted">
              {line}
            </li>
          ))}
        </ul>
      )}
    </li>
  )
}
