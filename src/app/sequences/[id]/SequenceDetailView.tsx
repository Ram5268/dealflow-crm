'use client'

import { useCallback, useState } from 'react'
import { useRouter } from 'next/navigation'
import Link from 'next/link'
import { Clock, Mail, MessageSquare, Pencil } from 'lucide-react'
import { Badge, Button, EmptyState, useToast } from '@/components/ui'
import { cn } from '@/lib/ui/cn'
import { shortStamp } from '@/lib/ui/time'
import type { SequenceDetail } from '@/lib/sequences/queries'

const TABS = ['steps', 'enrollment', 'stats'] as const
type Tab = (typeof TABS)[number]
const TAB_LABELS: Record<Tab, string> = {
  steps: 'Steps',
  enrollment: 'Enrollment',
  stats: 'Stats',
}

function delayLabel(hours: number): string {
  if (hours === 0) return 'Immediately'
  if (hours % 24 === 0) return `Wait ${hours / 24}d`
  return `Wait ${hours}h`
}

export function SequenceDetailView({ sequence }: { sequence: SequenceDetail }) {
  const [tab, setTab] = useState<Tab>('steps')

  return (
    <div className="mx-auto max-w-4xl px-4 py-4">
      <header className="mb-3 flex items-start gap-2">
        <div className="min-w-0 flex-1">
          {/* AppShell's top bar owns the page <h1>; this contributes a heading, not a competing one (PR-D/PR-E pattern). */}
          <h2 className="truncate text-sm font-semibold text-fg">{sequence.name}</h2>
          <p className="truncate text-xs text-subtle">
            {sequence.description || 'No description'} · {sequence.channel}
          </p>
        </div>
        <Button asChild variant="secondary" size="sm">
          <Link href={`/sequences/${sequence.id}/edit`}>
            <Pencil size={13} />
            Edit
          </Link>
        </Button>
      </header>

      <div className="mb-3 flex items-center gap-1 border-b border-line">
        {TABS.map((t) => (
          <button
            key={t}
            type="button"
            onClick={() => setTab(t)}
            aria-pressed={t === tab}
            className={cn(
              '-mb-px border-b-2 px-3 py-1.5 text-xs font-medium transition-colors',
              t === tab
                ? 'border-accent text-fg'
                : 'border-transparent text-muted hover:text-fg',
            )}
          >
            {TAB_LABELS[t]}
          </button>
        ))}
      </div>

      {tab === 'steps' && <StepsTab sequence={sequence} />}
      {tab === 'enrollment' && <EnrollmentTab sequence={sequence} />}
      {tab === 'stats' && <StatsTab sequence={sequence} />}
    </div>
  )
}

function StepsTab({ sequence }: { sequence: SequenceDetail }) {
  if (sequence.steps.length === 0) {
    return (
      <EmptyState
        icon={<Clock />}
        title="No steps yet."
        description="Add steps in the editor — every step sends a template."
        action={
          <Button asChild variant="primary" size="sm">
            <Link href={`/sequences/${sequence.id}/edit`}>Edit sequence</Link>
          </Button>
        }
      />
    )
  }

  return (
    <ol className="flex flex-col gap-2">
      {sequence.steps.map((s, i) => {
        const Icon = s.channel === 'sms' ? MessageSquare : Mail
        return (
          <li key={s.id} className="flex gap-3">
            {/* Timeline rail */}
            <div className="flex flex-col items-center">
              <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full border border-line bg-elevated text-[10px] font-medium text-muted">
                {i + 1}
              </span>
              {i < sequence.steps.length - 1 && <span className="w-px flex-1 bg-line" />}
            </div>

            <div className="mb-2 min-w-0 flex-1 rounded-lg border border-line bg-elevated p-3">
              <div className="mb-1 flex items-center gap-2">
                <Icon size={13} className="shrink-0 text-subtle" />
                <Badge tone={s.channel === 'sms' ? 'warning' : 'accent'}>{s.channel}</Badge>
                <span className="text-xs text-subtle">{delayLabel(s.delayHours)}</span>
              </div>
              {s.templateName ? (
                <>
                  <p className="truncate text-sm font-medium text-fg">
                    <Link href={`/templates/${s.templateId}`} className="hover:underline">
                      {s.templateName}
                    </Link>
                  </p>
                  {s.templateSubject && (
                    <p className="truncate text-xs text-muted">{s.templateSubject}</p>
                  )}
                  <p className="mt-1 line-clamp-2 text-xs text-subtle">{s.templatePreview}</p>
                </>
              ) : (
                <p className="text-sm text-danger">
                  Template missing — it may have been deleted.
                </p>
              )}
            </div>
          </li>
        )
      })}
    </ol>
  )
}

function EnrollmentTab({ sequence }: { sequence: SequenceDetail }) {
  const router = useRouter()
  const { toast } = useToast()
  const [busy, setBusy] = useState<string | null>(null)

  const setStatus = useCallback(
    async (id: string, status: 'active' | 'paused' | 'cancelled') => {
      setBusy(id)
      try {
        const res = await fetch(`/api/comms/enrollments/${id}`, {
          method: 'PATCH',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ status }),
        })
        if (!res.ok) {
          toast({ tone: 'danger', title: 'Could not update enrollment' })
          return
        }
        router.refresh()
      } finally {
        setBusy(null)
      }
    },
    [router, toast],
  )

  if (sequence.enrollments.length === 0) {
    return (
      <EmptyState
        title="Nobody is enrolled yet."
        description="Enroll a lead from its detail page."
      />
    )
  }

  return (
    <div className="overflow-hidden rounded-lg border border-line">
      <table className="w-full text-sm">
        <thead className="bg-hover text-left text-xs font-medium text-muted">
          <tr>
            <th className="px-3 py-2">Contact</th>
            <th className="px-3 py-2">Step</th>
            <th className="px-3 py-2">Next fire</th>
            <th className="px-3 py-2">Status</th>
            <th className="px-3 py-2" />
          </tr>
        </thead>
        <tbody>
          {sequence.enrollments.map((e) => (
            <tr key={e.id} className="border-t border-line">
              <td className="px-3 py-2">
                {e.leadId ? (
                  <Link href={`/leads/${e.leadId}`} className="text-accent hover:underline">
                    {e.contactName}
                  </Link>
                ) : (
                  e.contactName
                )}
              </td>
              <td className="px-3 py-2 text-muted">
                {e.currentStepOrdinal !== null ? `Step ${e.currentStepOrdinal + 1}` : '—'}
              </td>
              <td className="px-3 py-2 text-muted">
                {e.nextFireAt ? shortStamp(new Date(e.nextFireAt)) : '—'}
              </td>
              <td className="px-3 py-2">
                <Badge
                  tone={
                    e.status === 'active' ? 'success' : e.status === 'paused' ? 'warning' : 'neutral'
                  }
                >
                  {e.status}
                </Badge>
              </td>
              <td className="px-3 py-2 text-right">
                <div className="flex justify-end gap-1">
                  {e.status === 'active' && (
                    <Button size="sm" variant="ghost" disabled={busy === e.id} onClick={() => setStatus(e.id, 'paused')}>
                      Pause
                    </Button>
                  )}
                  {e.status === 'paused' && (
                    <Button size="sm" variant="ghost" disabled={busy === e.id} onClick={() => setStatus(e.id, 'active')}>
                      Resume
                    </Button>
                  )}
                  {e.status !== 'cancelled' && (
                    <Button size="sm" variant="ghost" disabled={busy === e.id} onClick={() => setStatus(e.id, 'cancelled')}>
                      Unenroll
                    </Button>
                  )}
                </div>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

function StatsTab({ sequence }: { sequence: SequenceDetail }) {
  const { sent, failed, queued, replies } = sequence.stats
  const cells = [
    { label: 'Sent', value: sent },
    { label: 'Queued', value: queued },
    { label: 'Failed', value: failed },
    { label: 'Replies', value: replies },
  ]

  return (
    <div className="flex flex-col gap-3">
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        {cells.map((c) => (
          <div key={c.label} className="rounded-lg border border-line bg-elevated px-3 py-2">
            <p className="text-xs font-medium text-muted">{c.label}</p>
            <p className="mt-1 text-2xl font-semibold leading-none text-fg">{c.value}</p>
          </div>
        ))}
      </div>

      <div className="rounded-lg border border-line bg-elevated px-3 py-2">
        <p className="text-xs font-medium text-muted">Open rate · Bounce rate</p>
        <p className="mt-1 text-sm text-subtle">
          Not tracked. Nothing in the schema records opens, clicks or bounces, so showing a
          percentage here would be invented.
        </p>
      </div>

      <p className="text-xs text-subtle">
        Replies counts incoming messages from enrolled contacts, which may include conversations
        unrelated to this sequence — replies carry no sequence attribution.
      </p>
    </div>
  )
}
