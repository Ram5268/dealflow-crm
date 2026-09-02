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
    <div className="px-4 py-4">
      <div className="mb-3 flex items-center gap-2">
        <div className="flex flex-1 items-center gap-1">
          {CHANNEL_TABS.map((t) => (
            <button
              key={t.key || 'all'}
              type="button"
              onClick={() => setChannel(t.key)}
              aria-pressed={t.key === channel}
              className={cn(
                'flex h-6 items-center rounded-md px-2 text-sm font-normal transition-colors',
                t.key === channel ? 'bg-line text-fg' : 'text-muted hover:bg-hover hover:text-fg',
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
        <div className="overflow-hidden border-b border-line">
          <table className="w-full border-collapse text-base">
            {/* Close bands the header in the page ground at 14px/700. */}
            <thead className="bg-bg text-left text-base font-bold text-fg">
              <tr>
                <th className="h-[41px] border-b border-r border-line px-3">Name</th>
                <th className="h-[41px] border-b border-r border-line px-3">Channel</th>
                <th className="h-[41px] border-b border-r border-line px-3">Subject</th>
                <th className="h-[41px] border-b border-r border-line px-3">Last used</th>
                <th className="h-[41px] border-b border-line px-3">Created</th>
              </tr>
            </thead>
            <tbody>
              {templates.map((t) => (
                <tr key={t.id} className="h-10 border-b border-line hover:bg-hover">
                  <td className="border-r border-line px-3">
                    <Link href={`/templates/${t.id}`} className="font-medium text-accent hover:underline">
                      {t.name}
                    </Link>
                  </td>
                  <td className="border-r border-line px-3">
                    <Badge tone={t.channel === 'sms' ? 'warning' : 'accent'}>{t.channel}</Badge>
                  </td>
                  <td className="max-w-xs truncate border-r border-line px-3 text-muted">{t.subject ?? '—'}</td>
                  <td className="border-r border-line px-3 text-muted">
                    {t.lastUsedAt ? shortStamp(new Date(t.lastUsedAt)) : 'Never'}
                  </td>
                  <td className="px-3 text-muted">{shortStamp(new Date(t.createdAt))}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}
