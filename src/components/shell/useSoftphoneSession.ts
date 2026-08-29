'use client'

import { useEffect, useRef, useState } from 'react'

export interface SoftphoneSession {
  callId: string
  state: 'connected' | 'wrapup'
  connectedAt: string
  /** Hydrated from the ammunition endpoint; null until it lands. */
  partyName: string | null
  disposition: string | null
}

/** How long the bar lingers after a call ends before it clears itself. */
export const WRAPUP_MS = 8000

/**
 * Live dial-session state for the persistent softphone bar.
 *
 * Wire contract (verified in the M0 audit): subscribes to
 * `GET /api/telephony/stream`, an SSE bridge over the Postgres `crm_call`
 * LISTEN channel. That channel carries only `call.connected` and
 * `call.completed` — the four-state bar in brief §7 is not on the wire — so the
 * bar renders those two states plus a client-side elapsed timer.
 *
 * Read-only: this hook never posts. Placing, pacing and hanging up calls stay
 * entirely with Agent B's dialer.
 */
export function useSoftphoneSession(): SoftphoneSession | null {
  const [session, setSession] = useState<SoftphoneSession | null>(null)
  const clearTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    const es = new EventSource('/api/telephony/stream')
    let cancelled = false

    async function hydrateParty(callId: string) {
      try {
        const res = await fetch(`/api/telephony/calls/${callId}/ammunition`)
        if (!res.ok || cancelled) return
        const ammo = await res.json()
        const name: string | null = ammo?.contact?.displayName ?? ammo?.lead?.displayName ?? null
        if (!name) return
        // Guard against a race with the next call: only label the call we asked about.
        setSession((prev) => (prev && prev.callId === callId ? { ...prev, partyName: name } : prev))
      } catch {
        /* the bar is still useful without a name */
      }
    }

    es.onmessage = (e) => {
      let evt: { type?: string; callId?: string; connectedAt?: string; disposition?: string }
      try {
        evt = JSON.parse(e.data)
      } catch {
        return // keepalive or non-JSON frame
      }
      if (!evt.callId) return

      if (evt.type === 'call.connected') {
        if (clearTimer.current) clearTimeout(clearTimer.current)
        setSession({
          callId: evt.callId,
          state: 'connected',
          connectedAt: evt.connectedAt ?? new Date().toISOString(),
          partyName: null,
          disposition: null,
        })
        void hydrateParty(evt.callId)
        return
      }

      if (evt.type === 'call.completed') {
        const endedId = evt.callId
        // Functional update: comparing against a captured `session` here would
        // read the value from the render that opened the stream, which is null
        // forever.
        setSession((prev) =>
          prev && prev.callId === endedId
            ? { ...prev, state: 'wrapup', disposition: evt.disposition ?? null }
            : prev,
        )
        if (clearTimer.current) clearTimeout(clearTimer.current)
        clearTimer.current = setTimeout(() => {
          setSession((prev) => (prev && prev.callId === endedId ? null : prev))
        }, WRAPUP_MS)
      }
    }

    es.onerror = () => {
      /* EventSource reconnects on its own */
    }

    return () => {
      cancelled = true
      if (clearTimer.current) clearTimeout(clearTimer.current)
      es.close()
    }
  }, [])

  return session
}

/** Whole seconds since `since`, ticking once a second while `running`. */
export function useElapsedSeconds(since: string, running: boolean): number {
  const [seconds, setSeconds] = useState(0)

  useEffect(() => {
    const startedAt = new Date(since).getTime()
    const tick = () => setSeconds(Math.max(0, Math.floor((Date.now() - startedAt) / 1000)))
    tick()
    if (!running) return
    const id = setInterval(tick, 1000)
    return () => clearInterval(id)
  }, [since, running])

  return seconds
}

export function formatDuration(totalSeconds: number): string {
  const m = Math.floor(totalSeconds / 60)
  const s = totalSeconds % 60
  return `${m}:${String(s).padStart(2, '0')}`
}
