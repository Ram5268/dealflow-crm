'use client'

import Link from 'next/link'
import { PhoneCall } from 'lucide-react'
import { Badge, Button } from '@/components/ui'
import {
  formatDuration,
  useElapsedSeconds,
  useSoftphoneSession,
} from './useSoftphoneSession'

/**
 * Persistent call-status strip. Hidden entirely when no session is active, so
 * it costs zero vertical space during normal work.
 *
 * Status only — every call control lives on /dialer. The bar deliberately
 * cannot place, pace or end a call; it reports what Agent B's dialer is doing.
 */
export function SoftphoneBar() {
  const session = useSoftphoneSession()
  if (!session) return null
  return <SoftphoneBarBody session={session} />
}

function SoftphoneBarBody({
  session,
}: {
  session: NonNullable<ReturnType<typeof useSoftphoneSession>>
}) {
  const connected = session.state === 'connected'
  // Hooks must run unconditionally, hence the split component — the parent
  // returns null before this ever mounts.
  const seconds = useElapsedSeconds(session.connectedAt, connected)

  return (
    <div
      role="status"
      aria-live="polite"
      style={{ height: 'var(--softphone-h)' }}
      className="flex shrink-0 items-center gap-3 border-t border-line bg-elevated px-4"
    >
      <PhoneCall size={15} className={connected ? 'text-success' : 'text-subtle'} />
      <Badge tone={connected ? 'success' : 'neutral'}>{connected ? 'On call' : 'Wrap-up'}</Badge>

      <span className="min-w-0 flex-1 truncate text-sm text-fg">
        {session.partyName ?? 'Connecting…'}
      </span>

      {session.disposition && <Badge tone="neutral">{session.disposition}</Badge>}

      <span className="shrink-0 font-mono text-sm tabular-nums text-muted">
        {formatDuration(seconds)}
      </span>

      <Button asChild variant="secondary" size="sm">
        <Link href="/dialer">Open dialer</Link>
      </Button>
    </div>
  )
}
