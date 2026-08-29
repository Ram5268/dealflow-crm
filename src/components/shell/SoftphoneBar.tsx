'use client'

import { PhoneOff } from 'lucide-react'
import { Badge, IconButton } from '@/components/ui'
import { useSoftphoneSession } from './useSoftphoneSession'

/**
 * Persistent call-status strip. Hidden entirely when no session is active, so
 * it costs zero vertical space during normal work.
 */
export function SoftphoneBar() {
  const session = useSoftphoneSession()
  if (!session) return null

  return (
    <div
      style={{ height: 'var(--softphone-h)' }}
      className="flex shrink-0 items-center gap-3 border-t border-line bg-elevated px-4"
    >
      <Badge tone={session.state === 'connected' ? 'success' : 'neutral'}>
        {session.state === 'connected' ? 'On call' : 'Wrap-up'}
      </Badge>
      <span className="min-w-0 flex-1 truncate text-sm text-fg">{session.callId}</span>
      <IconButton label="Hang up">
        <PhoneOff size={15} />
      </IconButton>
    </div>
  )
}
