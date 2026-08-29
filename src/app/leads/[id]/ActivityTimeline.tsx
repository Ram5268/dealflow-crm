'use client'

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
      {items.map((a) => (
        <li key={a.id} className="border-l-2 border-line py-1.5 pl-3">
          <div className="flex items-baseline justify-between gap-2">
            <span className="text-sm font-medium text-fg">{a.type}</span>
            <time dateTime={a.activityAt} className="shrink-0 text-xs text-subtle">
              {FMT.format(new Date(a.activityAt))}
            </time>
          </div>
          {a.bodyText && <p className="mt-0.5 text-sm text-muted">{a.bodyText}</p>}
        </li>
      ))}
    </ul>
  )
}
