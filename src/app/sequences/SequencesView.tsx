import Link from 'next/link'
import { Plus, Zap } from 'lucide-react'
import { Badge, Button, EmptyState } from '@/components/ui'
import { shortStamp } from '@/lib/ui/time'
import type { SequenceRow } from '@/lib/sequences/queries'

/**
 * Sequence list. Close's equivalent is Workflows (/sequences redirects there):
 * Name / Call Tasks / Stats / Last activity / Owner, with Active + Archived as
 * TABS rather than a per-row status pill — see reference/close/sequences-list.png.
 *
 * Owner is dropped (single-seat) and "Active/Idle" is derived, because
 * `Sequence` has no status column: active means something is enrolled and
 * running right now.
 */
export function SequencesView({ sequences }: { sequences: SequenceRow[] }) {
  return (
    <div className="px-4 py-4">
      <div className="mb-3 flex items-center justify-end">
        <Button asChild variant="primary" size="sm">
          <Link href="/sequences/new">
            <Plus size={13} />
            New sequence
          </Link>
        </Button>
      </div>

      {sequences.length === 0 ? (
        <EmptyState
          icon={<Zap />}
          title="No sequences yet. Create your first."
          description="A sequence sends a fixed series of email or SMS steps to everyone enrolled."
          action={
            <Button asChild variant="primary" size="sm">
              <Link href="/sequences/new">
                <Plus size={13} />
                New sequence
              </Link>
            </Button>
          }
        />
      ) : (
        <div className="overflow-hidden border-b border-line">
          <table className="w-full border-collapse text-base">
            <thead className="bg-bg text-left text-base font-bold text-fg">
              <tr>
                <th className="h-[41px] border-b border-r border-line px-3">Name</th>
                <th className="h-[41px] border-b border-r border-line px-3">Steps</th>
                <th className="h-[41px] border-b border-r border-line px-3">Enrolled</th>
                <th className="h-[41px] border-b border-r border-line px-3">Status</th>
                <th className="h-[41px] border-b border-r border-line px-3">Last activity</th>
                <th className="h-[41px] border-b border-line px-3">Created</th>
              </tr>
            </thead>
            <tbody>
              {sequences.map((s) => (
                <tr key={s.id} className="h-10 border-b border-line hover:bg-hover">
                  <td className="border-r border-line px-3">
                    <Link href={`/sequences/${s.id}`} className="font-medium text-accent hover:underline">
                      {s.name}
                    </Link>
                    {s.description && (
                      <span className="ml-2 text-xs text-subtle">{s.description}</span>
                    )}
                  </td>
                  <td className="border-r border-line px-3 text-muted">{s.stepCount}</td>
                  <td className="border-r border-line px-3 text-muted">
                    {s.activeEnrollments}
                    {s.totalEnrollments !== s.activeEnrollments && (
                      <span className="text-subtle"> / {s.totalEnrollments}</span>
                    )}
                  </td>
                  <td className="border-r border-line px-3">
                    <Badge tone={s.activity === 'active' ? 'success' : 'neutral'}>
                      {s.activity === 'active' ? 'Active' : 'Idle'}
                    </Badge>
                  </td>
                  <td className="border-r border-line px-3 text-muted">
                    {s.lastActivityAt ? shortStamp(new Date(s.lastActivityAt)) : '—'}
                  </td>
                  <td className="px-3 text-muted">{shortStamp(new Date(s.createdAt))}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}
