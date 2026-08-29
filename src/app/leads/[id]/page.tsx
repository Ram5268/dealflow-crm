import Link from 'next/link'
import { notFound } from 'next/navigation'
import { ExternalLink, Mail, Phone, Zap } from 'lucide-react'
import { prisma } from '@/lib/prisma'
import { getCurrentOrgId } from '@/lib/shell/orgContext'
import { hydrateCustomFields } from '@/lib/core-data/leads/serialize'
import { Badge, Button, EmptyState, Tooltip } from '@/components/ui'
import { ActivityTimeline } from './ActivityTimeline'

export const dynamic = 'force-dynamic'

function Card({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="rounded-lg border border-line bg-elevated">
      <h2 className="border-b border-line px-3 py-2 text-xs font-semibold uppercase tracking-wide text-subtle">
        {title}
      </h2>
      <div className="px-3 py-2.5">{children}</div>
    </section>
  )
}

function Row({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex gap-3 py-1 text-sm">
      <dt className="w-28 shrink-0 text-subtle">{label}</dt>
      <dd className="min-w-0 flex-1 break-words text-fg">{value || <span className="text-subtle">—</span>}</dd>
    </div>
  )
}

export default async function LeadDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const organizationId = await getCurrentOrgId()
  const lead = await prisma.lead.findFirst({
    where: { id, organizationId },
    include: { contacts: { include: { phones: true, emails: true } } },
  })
  if (!lead) notFound()

  const [customFields, activities] = await Promise.all([
    hydrateCustomFields(id),
    prisma.activity.findMany({
      where: { organizationId, leadId: id },
      orderBy: [{ activityAt: 'desc' }],
      take: 50,
    }),
  ])

  return (
    <div className="flex h-full flex-col">
      {/* Header — identity + quick actions */}
      <header className="flex shrink-0 flex-wrap items-center gap-3 border-b border-line px-4 py-3">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <h1 className="min-w-0 truncate text-lg font-semibold text-fg">{lead.displayName}</h1>
            {lead.statusLabel && <Badge>{lead.statusLabel}</Badge>}
            {lead.priorityScore != null && (
              <Badge tone="accent">Priority {lead.priorityScore}</Badge>
            )}
          </div>
          {lead.primaryAddressFull && (
            <p className="mt-0.5 truncate text-sm text-muted">{lead.primaryAddressFull}</p>
          )}
        </div>

        <div className="flex shrink-0 items-center gap-2">
          <Button asChild>
            <Link href="/dialer">
              <Phone size={13} />
              Call
            </Link>
          </Button>
          {/* Compose lands with the Inbox in M3; sequences in M4. Both are shown
              disabled so the header does not reflow when they go live. */}
          <Tooltip content="Compose ships in M3">
            <div>
              <Button disabled>
                <Mail size={13} />
                Email
              </Button>
            </div>
          </Tooltip>
          <Tooltip content="Sequences ship in M4">
            <div>
              <Button disabled>
                <Zap size={13} />
                Add to sequence
              </Button>
            </div>
          </Tooltip>
        </div>
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto p-4">
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-[340px_minmax(0,1fr)]">
          {/* Left rail — structured data, ~340px. Matches the live Close
              lead page, where Details/Tasks/Opportunities/Contacts/Fields sit
              in a narrow left rail. We ship the three we have data for.
              Reference: reference/close/lead-detail.png */}
          <div className="flex flex-col gap-4">
            <Card title="Property">
              <dl>
                <Row label="Address" value={lead.primaryAddressFull} />
                <Row label="Neighborhood" value={lead.primaryAddressSummary} />
                <Row label="Source" value={lead.source} />
                <Row label="Timezone" value={lead.timezone} />
                <Row
                  label="Match fit"
                  value={lead.topMatchFit != null ? `${lead.topMatchFit}` : null}
                />
                <Row label="Capture" value={lead.captureStatus} />
                <Row label="Why" value={lead.matchReason} />
                {lead.dealflowDeepLink && (
                  <Row
                    label="DealFlow"
                    value={
                      <a
                        href={lead.dealflowDeepLink}
                        target="_blank"
                        rel="noreferrer"
                        className="inline-flex items-center gap-1 text-accent hover:underline"
                      >
                        Open signal
                        <ExternalLink size={12} />
                      </a>
                    }
                  />
                )}
              </dl>
            </Card>

            <Card title={`Contacts (${lead.contacts.length})`}>
              {lead.contacts.length === 0 ? (
                <p className="py-2 text-sm text-subtle">No contacts on this lead.</p>
              ) : (
                <ul className="flex flex-col divide-y divide-line">
                  {lead.contacts.map((c) => (
                    <li key={c.id} className="py-2 first:pt-0 last:pb-0">
                      <p className="text-sm font-medium text-fg">
                        {c.displayName}
                        {c.title && <span className="font-normal text-muted"> · {c.title}</span>}
                      </p>
                      <p className="mt-0.5 text-sm text-muted">
                        {c.phones.map((p) => p.phoneFormatted ?? p.phone).join(', ') || 'No phone'}
                      </p>
                      {c.emails.length > 0 && (
                        <p className="text-sm text-muted">{c.emails.map((e) => e.email).join(', ')}</p>
                      )}
                    </li>
                  ))}
                </ul>
              )}
            </Card>

            {customFields.length > 0 && (
              <Card title="Custom fields">
                <dl>
                  {customFields.map((f) => (
                    <Row key={f.definitionId} label={f.name} value={String(f.value)} />
                  ))}
                </dl>
              </Card>
            )}
          </div>

          {/* Activity timeline owns the wide column — a broker lives in the
              feed, so it gets the space. */}
          <Card title="Activity">
            {activities.length === 0 ? (
              <EmptyState
                title="No activity yet"
                description="Calls, emails and notes on this lead will appear here."
              />
            ) : (
              <ActivityTimeline
                items={activities.map((a) => ({
                  id: a.id,
                  type: a.type,
                  activityAt: a.activityAt.toISOString(),
                  bodyText: a.bodyText,
                }))}
              />
            )}
          </Card>

        </div>
      </div>
    </div>
  )
}
