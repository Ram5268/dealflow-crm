import Link from 'next/link'
import { prisma } from '@/lib/prisma'
import { getCurrentOrgId } from '@/lib/shell/orgContext'
import { Nav } from '@/components/Nav'

export const dynamic = 'force-dynamic'

// Leads list. Server-rendered; columns = displayName / status / priority /
// phone count. Read-only for email; this is the CRM contact list.
export default async function LeadsPage() {
  const organizationId = await getCurrentOrgId()
  const leads = await prisma.lead.findMany({
    where: { organizationId },
    orderBy: [{ priorityScore: { sort: 'desc', nulls: 'last' } }, { updatedAt: 'desc' }],
    take: 100,
    include: { _count: { select: { contacts: true } } },
  })

  return (
    <main>
      <Nav />
      <div className="mx-auto max-w-5xl px-4 py-6">
        <h1 className="mb-4 text-lg font-semibold">Leads ({leads.length})</h1>
        <div className="overflow-hidden rounded-lg border border-neutral-200">
          <table className="w-full text-sm">
            <thead className="bg-neutral-50 text-left text-xs uppercase text-neutral-500">
              <tr>
                <th className="px-4 py-2">Name</th>
                <th className="px-4 py-2">Status</th>
                <th className="px-4 py-2">Priority</th>
                <th className="px-4 py-2">Contacts</th>
                <th className="px-4 py-2">Source</th>
              </tr>
            </thead>
            <tbody>
              {leads.map((l) => (
                <tr key={l.id} className="border-t border-neutral-100 hover:bg-neutral-50">
                  <td className="px-4 py-2">
                    <Link href={`/leads/${l.id}`} className="text-blue-700 hover:underline">
                      {l.displayName}
                    </Link>
                  </td>
                  <td className="px-4 py-2">{l.statusLabel ?? '—'}</td>
                  <td className="px-4 py-2">{l.priorityScore ?? '—'}</td>
                  <td className="px-4 py-2">{l._count.contacts}</td>
                  <td className="px-4 py-2 text-neutral-500">{l.source ?? '—'}</td>
                </tr>
              ))}
              {leads.length === 0 && (
                <tr>
                  <td colSpan={5} className="px-4 py-8 text-center text-neutral-400">
                    No leads yet. Import a Mojo CSV to get started.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>
    </main>
  )
}
