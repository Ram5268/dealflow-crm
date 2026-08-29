import Link from 'next/link'
import { CheckSquare, ChevronRight, Inbox, PhoneMissed } from 'lucide-react'
import { Badge, type BadgeTone, EmptyState, Skeleton } from '@/components/ui'
import { shortStamp } from '@/lib/ui/time'
import { getNeedsAttention, type AttentionKind } from '@/lib/focus/summary'

const KIND_META: Record<
  AttentionKind,
  { label: string; tone: BadgeTone; icon: React.ComponentType<{ size?: number; className?: string }> }
> = {
  reply: { label: 'Reply', tone: 'accent', icon: Inbox },
  task: { label: 'Task', tone: 'neutral', icon: CheckSquare },
  callback: { label: 'Callback', tone: 'warning', icon: PhoneMissed },
}

export function NeedsAttentionSkeleton() {
  return (
    <div className="divide-y divide-line">
      {[0, 1, 2, 3, 4].map((i) => (
        <div key={i} className="flex h-11 items-center gap-3 px-3">
          <Skeleton className="h-3.5 w-14" />
          <Skeleton className="h-3.5 w-32" />
          <Skeleton className="h-3.5 flex-1" />
        </div>
      ))}
    </div>
  )
}

/**
 * The single work-the-list surface on Focus. Close opens onto one dense row
 * list, and this keeps that rhythm without duplicating /inbox: Focus projects
 * today's priorities across replies, tasks and callbacks; /inbox is the full
 * temporal triage of every message.
 */
export async function NeedsAttentionList({ organizationId }: { organizationId: string }) {
  const items = await getNeedsAttention(organizationId)

  if (items.length === 0) {
    return (
      <EmptyState
        icon={<CheckSquare />}
        title="Nothing needs you right now"
        description="Unread replies, tasks due today and unreturned calls land here."
      />
    )
  }

  return (
    <ul className="divide-y divide-line">
      {items.map((item) => {
        const meta = KIND_META[item.kind]
        const Icon = meta.icon
        return (
          <li key={item.key}>
            <Link
              href={item.href}
              className="flex h-11 items-center gap-3 px-3 text-sm hover:bg-hover"
            >
              <Icon size={14} className="shrink-0 text-subtle" />
              <Badge tone={item.overdue ? 'danger' : meta.tone} className="shrink-0">
                {item.overdue ? 'Overdue' : meta.label}
              </Badge>
              <span className="w-40 shrink-0 truncate font-medium text-fg">{item.title}</span>
              <span className="min-w-0 flex-1 truncate text-muted">{item.detail}</span>
              <span className="shrink-0 text-xs text-subtle">{shortStamp(item.at)}</span>
              <ChevronRight size={14} className="shrink-0 text-subtle" />
            </Link>
          </li>
        )
      })}
    </ul>
  )
}
