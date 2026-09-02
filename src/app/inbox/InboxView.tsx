'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import Link from 'next/link'
import { Archive, Inbox, Mail, MessageSquare, Voicemail } from 'lucide-react'
import { Badge, Button, EmptyState, Kbd, useToast } from '@/components/ui'
import { cn } from '@/lib/ui/cn'
import { isEditableTarget } from '@/lib/ui/hotkeys'
import { shortStamp } from '@/lib/ui/time'
import {
  FILTER_LABELS,
  FILTER_STORAGE_KEY,
  INBOX_FILTERS,
  type InboxChannel,
  type InboxFilter,
  type ThreadDetail,
  type ThreadSummary,
} from '@/lib/inbox/types'
import { ReplyDrawer } from './ReplyDrawer'
import { ComposeDrawer } from './ComposeDrawer'

const CHANNEL_ICON: Record<InboxChannel, typeof Mail> = {
  email: Mail,
  sms: MessageSquare,
  voicemail: Voicemail,
}

/** PATCH one message's inbox state. Read/archive are independent timestamps. */
async function patchMessage(id: string, data: { readAt?: string | null; archivedAt?: string | null }) {
  const res = await fetch(`/api/comms/messages/${id}`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(data),
  })
  if (!res.ok) throw new Error(`PATCH ${id} failed: ${res.status}`)
}

export function InboxView({
  threads,
  detail,
  filter,
  truncated,
  composeOpen,
}: {
  threads: ThreadSummary[]
  detail: ThreadDetail | null
  filter: InboxFilter
  truncated: boolean
  composeOpen: boolean
}) {
  const router = useRouter()
  const { toast } = useToast()
  const [cursor, setCursor] = useState(0)
  const [replyOpen, setReplyOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const listRef = useRef<HTMLUListElement>(null)

  const selectedKey = detail?.key ?? null

  const closeCompose = useCallback(() => {
    const next = new URLSearchParams(window.location.search)
    next.delete('compose')
    router.replace(next.size ? `/inbox?${next}` : '/inbox')
  }, [router])
  const cursorThread = threads[cursor] ?? null

  // Keep the cursor on the open thread when the server sends a new list.
  useEffect(() => {
    if (!selectedKey) return
    const i = threads.findIndex((t) => t.key === selectedKey)
    if (i >= 0) setCursor(i)
  }, [selectedKey, threads])

  // Clamp when a filter change shortens the list under the cursor.
  useEffect(() => {
    setCursor((c) => Math.min(c, Math.max(0, threads.length - 1)))
  }, [threads.length])

  const setFilter = useCallback(
    (next: InboxFilter) => {
      try {
        localStorage.setItem(FILTER_STORAGE_KEY, next)
      } catch {
        /* private mode — the URL still carries the choice */
      }
      // Changing filter drops the open thread: it may not be in the new list.
      router.push(next === 'all' ? '/inbox' : `/inbox?filter=${next}`)
    },
    [router],
  )

  const openThread = useCallback(
    (t: ThreadSummary) => {
      const q = new URLSearchParams({ thread: t.key })
      if (filter !== 'all') q.set('filter', filter)
      router.push(`/inbox?${q}`)
    },
    [router, filter],
  )

  const closeThread = useCallback(() => {
    router.push(filter === 'all' ? '/inbox' : `/inbox?filter=${filter}`)
  }, [router, filter])

  /**
   * Message ids this session has already auto-marked as read.
   *
   * Without it, pressing `u` on the OPEN thread is instantly undone: marking
   * unread triggers a refresh, the refreshed thread again contains unread
   * incoming messages, and this effect marks them read again. Remembering what
   * we marked lets an explicit user action win over the automatic one.
   */
  const autoMarked = useRef<Set<string>>(new Set())

  /** Opening a thread clears its unread messages. Serial PATCH: a thread holds
   *  a handful of messages, and D exposes no batch endpoint to consume. */
  useEffect(() => {
    if (!detail) return
    const unread = detail.items.filter(
      (i) =>
        i.kind === 'message' &&
        i.direction === 'incoming' &&
        !i.readAt &&
        !autoMarked.current.has(i.id),
    )
    if (unread.length === 0) return
    let cancelled = false
    ;(async () => {
      const now = new Date().toISOString()
      try {
        for (const item of unread) {
          await patchMessage(item.id, { readAt: now })
          autoMarked.current.add(item.id)
        }
        if (!cancelled) router.refresh()
      } catch {
        if (!cancelled) toast({ tone: 'danger', title: 'Could not mark as read' })
      }
    })()
    return () => {
      cancelled = true
    }
  }, [detail, router, toast])

  const toggleRead = useCallback(
    async (t: ThreadSummary) => {
      if (t.incomingIds.length === 0) {
        // Voicemails (Call rows carry no readAt) and threads where every message
        // is outbound. Neither has anything to mark.
        toast({ title: 'Nothing to mark', description: 'This thread has no incoming messages.' })
        return
      }
      setBusy(true)
      try {
        const markRead = t.unreadCount > 0
        const now = new Date().toISOString()
        const ids = markRead ? t.unreadIds : t.incomingIds
        for (const id of ids) {
          await patchMessage(id, { readAt: markRead ? now : null })
          // Marking unread must survive the refresh; marking read by hand
          // re-arms the automatic path for that message.
          if (markRead) autoMarked.current.delete(id)
          else autoMarked.current.add(id)
        }
        router.refresh()
      } catch {
        toast({ tone: 'danger', title: 'Could not change read state' })
      } finally {
        setBusy(false)
      }
    },
    [router, toast],
  )

  const archiveThread = useCallback(
    async (t: ThreadSummary) => {
      if (t.messageIds.length === 0) {
        toast({ title: 'Voicemails cannot be archived yet' })
        return
      }
      setBusy(true)
      try {
        const now = new Date().toISOString()
        for (const id of t.messageIds) await patchMessage(id, { archivedAt: now })
        if (t.key === selectedKey) closeThread()
        else router.refresh()
        toast({ title: 'Archived', description: t.title })
      } catch {
        toast({ tone: 'danger', title: 'Could not archive' })
      } finally {
        setBusy(false)
      }
    },
    [router, toast, selectedKey, closeThread],
  )

  // ---- keyboard nav (brief §8 M3 item 5) ----------------------------------
  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if (e.metaKey || e.ctrlKey || e.altKey) return

      // Esc must work from inside the composer — it is how you get back out.
      if (e.key === 'Escape') {
        if (replyOpen) {
          setReplyOpen(false)
          e.preventDefault()
        } else if (selectedKey && !isEditableTarget(e.target)) {
          closeThread()
          e.preventDefault()
        }
        return
      }
      // Every other shortcut is a bare letter, so it must not fire while typing.
      if (isEditableTarget(e.target)) return

      switch (e.key) {
        case 'j':
          e.preventDefault()
          setCursor((c) => Math.min(c + 1, threads.length - 1))
          break
        case 'k':
          e.preventDefault()
          setCursor((c) => Math.max(c - 1, 0))
          break
        case 'Enter':
          if (cursorThread) {
            e.preventDefault()
            openThread(cursorThread)
          }
          break
        case 'r':
          if (cursorThread) {
            e.preventDefault()
            if (cursorThread.key !== selectedKey) openThread(cursorThread)
            setReplyOpen(true)
          }
          break
        case 'e':
          if (cursorThread && !busy) {
            e.preventDefault()
            void archiveThread(cursorThread)
          }
          break
        case 'u':
          if (cursorThread && !busy) {
            e.preventDefault()
            void toggleRead(cursorThread)
          }
          break
      }
    }
    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  }, [threads.length, cursorThread, selectedKey, replyOpen, busy, openThread, closeThread, archiveThread, toggleRead])

  // Keep the cursor row in view during j/k runs.
  useEffect(() => {
    listRef.current?.querySelector<HTMLElement>('[data-cursor="true"]')?.scrollIntoView({ block: 'nearest' })
  }, [cursor])

  const emptyCopy = useMemo(
    () =>
      filter === 'all'
        ? { title: "You're at zero.", description: 'New email, SMS and voicemail land here as they arrive.' }
        : { title: `No ${FILTER_LABELS[filter].toLowerCase()} right now.`, description: undefined },
    [filter],
  )

  return (
    <div className="flex h-full min-h-0">
      {/* LEFT — thread list */}
      <div className="flex w-full min-w-0 flex-col border-r border-line lg:w-[380px] lg:shrink-0">
        <div className="flex shrink-0 items-center gap-1 border-b border-line px-2 py-1.5">
          {INBOX_FILTERS.map((f) => (
            <button
              key={f}
              type="button"
              onClick={() => setFilter(f)}
              aria-pressed={f === filter}
              className={cn(
                'rounded-md px-2 py-1 text-xs font-medium transition-colors',
                f === filter ? 'bg-active text-fg' : 'text-muted hover:bg-hover hover:text-fg',
              )}
            >
              {FILTER_LABELS[f]}
            </button>
          ))}
        </div>

        {threads.length === 0 ? (
          <EmptyState
            icon={<Inbox />}
            title={emptyCopy.title}
            description={emptyCopy.description}
            className={filter === 'all' ? undefined : 'py-8'}
          />
        ) : (
          <ul ref={listRef} className="min-h-0 flex-1 divide-y divide-line overflow-y-auto">
            {threads.map((t, i) => {
              const Icon = CHANNEL_ICON[t.channel]
              const unread = t.unreadCount > 0
              return (
                <li key={t.key}>
                  <button
                    type="button"
                    data-cursor={i === cursor ? 'true' : undefined}
                    aria-current={t.key === selectedKey ? 'true' : undefined}
                    onClick={() => {
                      setCursor(i)
                      openThread(t)
                    }}
                    className={cn(
                      'flex w-full items-start gap-2 px-3 py-2 text-left text-sm',
                      t.key === selectedKey ? 'bg-active' : 'hover:bg-hover',
                      i === cursor && t.key !== selectedKey && 'bg-hover',
                    )}
                  >
                    <Icon size={14} className="mt-0.5 shrink-0 text-subtle" />
                    <span className="min-w-0 flex-1">
                      <span className="flex items-baseline gap-2">
                        <span className={cn('min-w-0 flex-1 truncate', unread ? 'font-semibold text-fg' : 'text-fg')}>
                          {t.title}
                        </span>
                        <span className="shrink-0 text-xs text-subtle">{shortStamp(new Date(t.at))}</span>
                      </span>
                      <span className={cn('block truncate text-xs', unread ? 'text-muted' : 'text-subtle')}>
                        {t.subject ? `${t.subject} — ` : ''}
                        {t.preview}
                      </span>
                    </span>
                    {unread && (
                      <span className="mt-1 h-1.5 w-1.5 shrink-0 rounded-full bg-accent" aria-label="Unread" />
                    )}
                  </button>
                </li>
              )
            })}
          </ul>
        )}

        {truncated && (
          <p className="shrink-0 border-t border-line px-3 py-1.5 text-xs text-subtle">
            Showing the most recent threads only.
          </p>
        )}
      </div>

      {/* RIGHT — thread detail */}
      <div className="hidden min-w-0 flex-1 flex-col lg:flex">
        {detail ? (
          <ThreadPane
            detail={detail}
            busy={busy}
            onReply={() => setReplyOpen(true)}
            onArchive={() => cursorThread && archiveThread(cursorThread)}
          />
        ) : (
          <EmptyState title="Select a thread to open it." description="Use j / k to move and Enter to open." />
        )}
      </div>

      <ReplyDrawer
        open={replyOpen}
        onOpenChange={setReplyOpen}
        detail={detail}
        onSent={() => {
          setReplyOpen(false)
          router.refresh()
        }}
      />

      {/* Open state lives in the URL (?compose=1) so ⌘K can reach it from any
          page; closing drops the param rather than holding local state that the
          URL would contradict on a back navigation. */}
      <ComposeDrawer
        open={composeOpen}
        onOpenChange={(o) => {
          if (!o) closeCompose()
        }}
        onSent={() => {
          closeCompose()
          router.refresh()
        }}
      />
    </div>
  )
}

function ThreadPane({
  detail,
  busy,
  onReply,
  onArchive,
}: {
  detail: ThreadDetail
  busy: boolean
  onReply: () => void
  onArchive: () => void
}) {
  return (
    <>
      <header className="flex shrink-0 items-center gap-2 border-b border-line px-4 py-2">
        <div className="min-w-0 flex-1">
          <h2 className="truncate text-sm font-semibold text-fg">{detail.subject || detail.title}</h2>
          <p className="truncate text-xs text-subtle">
            {detail.title}
            {detail.leadId && (
              <>
                {' · '}
                <Link href={`/leads/${detail.leadId}`} className="text-accent hover:underline">
                  View lead
                </Link>
              </>
            )}
          </p>
        </div>
        <Button size="sm" variant="secondary" onClick={onArchive} disabled={busy}>
          <Archive size={13} />
          Archive
        </Button>
        <Button size="sm" variant="primary" onClick={onReply}>
          Reply <Kbd className="ml-1">r</Kbd>
        </Button>
      </header>

      <div className="min-h-0 flex-1 space-y-3 overflow-y-auto px-4 py-3">
        {detail.items.map((item) => (
          <article
            key={item.id}
            className={cn(
              'rounded-lg border border-line p-3',
              item.direction === 'outgoing' ? 'bg-bg' : 'bg-elevated',
            )}
          >
            <div className="mb-1.5 flex items-baseline gap-2 text-xs">
              <span className="font-medium text-fg">{item.from || 'You'}</span>
              <Badge tone={item.direction === 'incoming' ? 'accent' : 'neutral'}>
                {item.direction === 'incoming' ? 'Received' : 'Sent'}
              </Badge>
              {item.status && item.status !== 'sent' && <Badge tone="warning">{item.status}</Badge>}
              <span className="ml-auto shrink-0 text-subtle">{shortStamp(new Date(item.at))}</span>
            </div>

            {item.kind === 'voicemail' ? (
              <div className="flex items-center gap-2 text-sm text-muted">
                <Voicemail size={14} className="text-subtle" />
                {item.audioUrl ? (
                  // eslint-disable-next-line jsx-a11y/media-has-caption
                  <audio controls src={item.audioUrl} className="h-8 w-full max-w-sm" />
                ) : (
                  <span>Recording unavailable</span>
                )}
                {item.durationSec ? <span className="text-xs text-subtle">{item.durationSec}s</span> : null}
              </div>
            ) : (
              // Plain text on purpose — see the bodyHtml note in threads.ts.
              <p className="whitespace-pre-wrap break-words text-sm text-fg">
                {item.bodyText || <span className="text-subtle">No message body.</span>}
              </p>
            )}
          </article>
        ))}
      </div>
    </>
  )
}

