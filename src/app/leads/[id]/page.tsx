import Link from 'next/link'
import { notFound } from 'next/navigation'
import { prisma } from '@/lib/prisma'
import { getCurrentOrgId } from '@/lib/shell/orgContext'
import { hydrateCustomFields } from '@/lib/core-data/leads/serialize'
import { Nav } from '@/components/Nav'

export const dynamic = 'force-dynamic'

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
    <main>
      <Nav />
      <div className="mx-auto max-w-3xl px-4 py-6">
        <Link href="/leads" className="text-sm text-blue-700 hover:underline">
          ← Leads
        </Link>
        <h1 className="mb-1 mt-2 text-xl font-semibold">{lead.displayName}</h1>
        <p className="mb-6 text-sm text-neutral-500">
          {lead.statusLabel ?? 'No status'} · priority {lead.priorityScore ?? '—'} · {lead.primaryAddressFull ?? 'no address'}
        </p>

        <Section title="Contacts">
          {lead.contacts.length === 0 && <Empty>No contacts</Empty>}
          {lead.contacts.map((c) => (
            <div key={c.id} className="rounded border border-neutral-200 p-3 text-sm">
              <div className="font-medium">{c.displayName}{c.title ? ` · ${c.title}` : ''}</div>
              <div className="text-neutral-600">
                {c.phones.map((p) => p.phoneFormatted ?? p.phone).join(', ') || 'no phone'}
              </div>
              <div className="text-neutral-600">{c.emails.map((e) => e.email).join(', ')}</div>
            </div>
          ))}
        </Section>

        {customFields.length > 0 && (
          <Section title="Custom Fields">
            <dl className="grid grid-cols-2 gap-2 text-sm">
              {customFields.map((f) => (
                <div key={f.definitionId}>
                  <dt className="text-neutral-500">{f.name}</dt>
                  <dd>{String(f.value)}</dd>
                </div>
              ))}
            </dl>
          </Section>
        )}

        <Section title="Activity">
          {activities.length === 0 && <Empty>No activity yet</Empty>}
          <ul className="space-y-2 text-sm">
            {activities.map((a) => (
              <li key={a.id} className="border-l-2 border-neutral-200 pl-3">
                <span className="font-medium">{a.type}</span>{' '}
                <span className="text-neutral-500">{a.activityAt.toISOString()}</span>
                {a.bodyText && <div className="text-neutral-600">{a.bodyText}</div>}
              </li>
            ))}
          </ul>
        </Section>
      </div>
    </main>
  )
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="mb-6">
      <h2 className="mb-2 text-sm font-semibold uppercase text-neutral-500">{title}</h2>
      <div className="space-y-2">{children}</div>
    </section>
  )
}
function Empty({ children }: { children: React.ReactNode }) {
  return <p className="text-sm text-neutral-400">{children}</p>
}
