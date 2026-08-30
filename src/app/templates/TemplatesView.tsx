'use client'

import { useRouter, useSearchParams } from 'next/navigation'
import Link from 'next/link'
import { FileText, Plus } from 'lucide-react'
import { Badge, Button, EmptyState } from '@/components/ui'
import { cn } from '@/lib/ui/cn'
import { shortStamp } from '@/lib/ui/time'
import type { TemplateRow } from '@/lib/sequences/queries'

const CHANNEL_TABS = [
  { key: '', label: 'All' },
  { key: 'email', label: 'Email' },
  { key: 'sms', label: 'SMS' },
] as const

/**
 * Template list. Close scopes templates by channel with tabs above the list
 * (reference/close/templates-list.png) — same here, minus their Snippets tab,
 * which is cut from this build.
 */
export function TemplatesView({ templates, channel }: { templates: TemplateRow[]; channel: string }) {
  const router = useRouter()
  const params = useSearchParams()

  function setChannel(next: string) {
    const q = new URLSearchParams(params.toString())
    if (next) q.set('channel', next)
    else q.delete('channel')
    router.push(`/templates${q.toString() ? `?${q}` : ''}`)
  }

  return (
    <div className="mx-auto max-w-5xl px-4 py-4">
      <div className="mb-3 flex items-center gap-2">
        <div className="flex flex-1 items-center gap-1">
          {CHANNEL_TABS.map((t) => (
            <button
              key={t.key || 'all'}
              type="button"
              onClick={() => setChannel(t.key)}
              aria-pressed={t.key === channel}
              className={cn(
                'rounded-md px-2 py-1 text-xs font-medium transition-colors',
                t.key === channel ? 'bg-active text-fg' : 'text-muted hover:bg-hover hover:text-fg',
              )}
            >
              {t.label}
            </button>
          ))}
        </div>
        <Button asChild variant="primary" size="sm">
          <Link href="/templates/new">
            <Plus size={13} />
            New template
          </Link>
        </Button>
      </div>

      {templates.length === 0 ? (
        <EmptyState
          icon={<FileText />}
          title="No templates yet."
          description="Templates are the body of every sequence step, so start here."
          action={
            <Button asChild variant="primary" size="sm">
              <Link href="/templates/new">
                <Plus size={13} />
                New template
              </Link>
            </Button>
          }
        />
      ) : (
        <div className="overflow-hidden rounded-lg border border-line">
          <table className="w-full text-sm">
            <thead className="bg-hover text-left text-xs font-medium text-muted">
              <tr>
                <th className="px-3 py-2">Name</th>
                <th className="px-3 py-2">Channel</th>
                <th className="px-3 py-2">Subject</th>
                <th className="px-3 py-2">Last used</th>
                <th className="px-3 py-2">Created</th>
              </tr>
            </thead>
            <tbody>
              {templates.map((t) => (
                <tr key={t.id} className="border-t border-line hover:bg-hover">
                  <td className="px-3 py-2">
                    <Link href={`/templates/${t.id}`} className="font-medium text-accent hover:underline">
                      {t.name}
                    </Link>
                  </td>
                  <td className="px-3 py-2">
                    <Badge tone={t.channel === 'sms' ? 'warning' : 'accent'}>{t.channel}</Badge>
                  </td>
                  <td className="max-w-xs truncate px-3 py-2 text-muted">{t.subject ?? '—'}</td>
                  <td className="px-3 py-2 text-muted">
                    {t.lastUsedAt ? shortStamp(new Date(t.lastUsedAt)) : 'Never'}
                  </td>
                  <td className="px-3 py-2 text-muted">{shortStamp(new Date(t.createdAt))}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}
