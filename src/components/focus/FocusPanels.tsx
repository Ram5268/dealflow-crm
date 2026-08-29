import Link from 'next/link'
import { CheckSquare, MessageSquare, PhoneCall, Target } from 'lucide-react'
import { Badge, type BadgeTone, Button, Skeleton } from '@/components/ui'
import { shortStamp } from '@/lib/ui/time'
import {
  getCallsToday,
  getDialQueue,
  getRepliesToday,
  getTasksDue,
} from '@/lib/focus/summary'
import { PanelCard, PanelEmpty, PanelRow } from './PanelCard'

/** Disposition → badge tone. Vocabulary is Agent B's frozen event enum (§7.1). */
const DISPOSITION_TONE: Record<string, BadgeTone> = {
  answered: 'success',
  'vm-left': 'warning',
  'vm-answer': 'warning',
  busy: 'neutral',
  'no-answer': 'neutral',
  abandoned: 'neutral',
  blocked: 'danger',
  error: 'danger',
}

export function PanelSkeleton() {
  return (
    <section className="rounded-lg border border-line bg-elevated px-3 py-3">
      <Skeleton className="h-3 w-24" />
      <Skeleton className="mt-2 h-6 w-10" />
      <Skeleton className="mt-3 h-3 w-full" />
      <Skeleton className="mt-1.5 h-3 w-4/5" />
    </section>
  )
}

// ---------------------------------------------------------------- dial queue

export async function DialQueueCard({ organizationId }: { organizationId: string }) {
  const q = await getDialQueue(organizationId)

  if (q.kind === 'no-view') {
    return (
      <PanelCard label="Dial queue" icon={<Target />} count="—">
        <PanelEmpty>
          No lead view saved yet. <Link href="/leads" className="text-accent hover:underline">Build one</Link> to
          start a queue.
        </PanelEmpty>
      </PanelCard>
    )
  }

  if (q.kind === 'error') {
    // Compliance is fail-closed; say so rather than render a misleading zero.
    return (
      <PanelCard label="Dial queue" icon={<Target />} count="—">
        <PanelEmpty>Could not verify who is callable right now.</PanelEmpty>
      </PanelCard>
    )
  }

  return (
    <PanelCard
      label="Dial queue"
      icon={<Target />}
      count={q.readyCount}
      countSuffix={q.atCap ? '+' : undefined}
      // Always present: dialing is the reason Ryan opens this app, so the
      // primary action must not vanish on a day the queue happens to be empty.
      action={
        <Button asChild variant="primary" size="sm">
          <Link href="/dialer">Start dialing</Link>
        </Button>
      }
      href={`/queue?viewId=${q.viewId}`}
      hrefLabel="Review queue"
    >
      {q.readyCount > 0 ? (
        <p className="px-1 py-1 text-xs text-subtle">
          Ready in <span className="text-muted">{q.viewName}</span>
          {q.excludedCompliance > 0 && ` · ${q.excludedCompliance} held by compliance`}
        </p>
      ) : (
        <PanelEmpty>
          Nobody callable right now
          {q.excludedCompliance > 0 && ` · ${q.excludedCompliance} held by compliance`}
          {q.excludedNoPhone > 0 && ` · ${q.excludedNoPhone} without a phone`}
        </PanelEmpty>
      )}
    </PanelCard>
  )
}

// --------------------------------------------------------------- calls today

export async function CallsTodayCard({ organizationId }: { organizationId: string }) {
  const { count, recent } = await getCallsToday(organizationId)

  return (
    <PanelCard label="Calls today" icon={<PhoneCall />} count={count}>
      {recent.length > 0 ? (
        recent.map((c) => (
          <PanelRow
            key={c.id}
            primary={c.leadName}
            secondary={shortStamp(c.at)}
            href={c.leadId ? `/leads/${c.leadId}` : undefined}
            trailing={
              c.disposition ? (
                <Badge tone={DISPOSITION_TONE[c.disposition] ?? 'neutral'}>{c.disposition}</Badge>
              ) : undefined
            }
          />
        ))
      ) : (
        <PanelEmpty>No calls yet today.</PanelEmpty>
      )}
    </PanelCard>
  )
}

// ------------------------------------------------------------- replies today

export async function RepliesTodayCard({ organizationId }: { organizationId: string }) {
  const { count, recent } = await getRepliesToday(organizationId)

  return (
    <PanelCard
      label="Replies today"
      icon={<MessageSquare />}
      count={count}
      href="/inbox"
      hrefLabel="Open inbox"
    >
      {recent.length > 0 ? (
        recent.map((r) => (
          <PanelRow
            key={r.id}
            primary={r.leadName}
            secondary={r.preview}
            trailing={<span className="text-subtle">{shortStamp(r.at)}</span>}
            href={r.leadId ? `/leads/${r.leadId}` : '/inbox'}
          />
        ))
      ) : (
        <PanelEmpty>No replies yet today.</PanelEmpty>
      )}
    </PanelCard>
  )
}

// ----------------------------------------------------------------- tasks due

export async function TasksDueCard({ organizationId }: { organizationId: string }) {
  const { count, top } = await getTasksDue(organizationId)

  return (
    <PanelCard label="Tasks due" icon={<CheckSquare />} count={count}>
      {top.length > 0 ? (
        top.map((t) => (
          <PanelRow
            key={t.id}
            primary={t.text}
            secondary={t.leadName ?? undefined}
            href={t.leadId ? `/leads/${t.leadId}` : undefined}
            trailing={
              t.overdue ? (
                <Badge tone="danger">Overdue</Badge>
              ) : (
                <span className="text-subtle">{shortStamp(t.dueDate)}</span>
              )
            }
          />
        ))
      ) : (
        <PanelEmpty>Nothing due today.</PanelEmpty>
      )}
    </PanelCard>
  )
}
