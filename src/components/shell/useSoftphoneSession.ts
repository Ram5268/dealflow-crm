'use client'

import { useEffect, useState } from 'react'

export interface SoftphoneSession {
  callId: string
  state: 'connected' | 'wrapup'
  connectedAt: string
}

/**
 * Live dial-session state for the persistent softphone bar.
 *
 * Wire contract (verified in the M0 audit): the bar subscribes to
 * `GET /api/telephony/stream`, an SSE bridge over the Postgres `crm_call`
 * LISTEN channel. The channel carries only `call.connected` and
 * `call.completed` — the four-state bar in brief §7 is not on the wire, so the
 * bar renders those two plus a client-side timer.
 *
 * TODO: Agent E M2 — subscribe for real and hydrate the party name from
 * GET /api/telephony/calls/[id]/ammunition. M1 ships the shell seam only, so
 * the bar stays hidden and the dialer page remains the live surface.
 */
export function useSoftphoneSession(): SoftphoneSession | null {
  const [session] = useState<SoftphoneSession | null>(null)
  useEffect(() => {
    // Intentionally inert until M2.
  }, [])
  return session
}
