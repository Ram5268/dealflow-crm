import type { CallListener } from './listener'

/**
 * The browser side of one call-status stream (Brief 50 PR 1, open item 6.1;
 * engineering precautions). Each open tab gets one of these; they all share
 * the server instance's single `LISTEN crm_call` connection (./listener).
 *
 * Wire format (unchanged for the softphone bar and the dialer): every
 * `crm_call` payload goes out as `data: <json>\n\n`, after an
 * `event: ready` frame once the LISTEN is in place. New:
 *  - `retry:` lines set how long the browser's EventSource waits before it
 *    reconnects (5 s normally; 30 s after the database connection broke);
 *  - a `: keepalive` comment every 25 s, so idle proxies don't cut the
 *    stream (EventSource ignores comment lines);
 *  - the stream ends itself after 4.5 minutes, before the route's
 *    `maxDuration` (300 s), so the function finishes cleanly instead of being
 *    stopped; the browser reconnects on its own.
 */

export const RECONNECT_MS = 5_000
export const RECONNECT_AFTER_DROP_MS = 30_000
export const HEARTBEAT_MS = 25_000
export const STREAM_LIFETIME_MS = 270_000

export interface CallStreamOptions {
  /** The request's abort signal: the browser went away. */
  signal?: AbortSignal
  heartbeatMs?: number
  lifetimeMs?: number
}

export function callStreamResponse(listener: CallListener, opts: CallStreamOptions = {}): Response {
  const { signal, heartbeatMs = HEARTBEAT_MS, lifetimeMs = STREAM_LIFETIME_MS } = opts
  const encoder = new TextEncoder()
  let controller!: ReadableStreamDefaultController<Uint8Array>
  let closed = false
  let leave: (() => void) | null = null
  let heartbeat: ReturnType<typeof setInterval> | undefined
  let lifetime: ReturnType<typeof setTimeout> | undefined

  function send(text: string): void {
    if (closed) return
    try {
      controller.enqueue(encoder.encode(text))
    } catch {
      finish() // the browser is gone
    }
  }

  /** Ends this stream once; `retryMs` tells the browser when to come back. */
  function finish(retryMs?: number): void {
    if (closed) return
    if (retryMs !== undefined) send(`retry: ${retryMs}\n\n`)
    closed = true
    clearInterval(heartbeat)
    clearTimeout(lifetime)
    signal?.removeEventListener('abort', onAbort)
    leave?.()
    leave = null
    try {
      controller.close()
    } catch {
      /* already closed or cancelled */
    }
  }
  const onAbort = () => finish()

  const stream = new ReadableStream<Uint8Array>({
    async start(c) {
      controller = c
      if (signal?.aborted) return finish()
      signal?.addEventListener('abort', onAbort, { once: true })
      // Started before the connection is in place, so even a connect that
      // hangs can't outlive the function.
      lifetime = setTimeout(() => finish(), lifetimeMs)
      send(`retry: ${RECONNECT_MS}\n\n`)
      let leaveNow: () => void
      try {
        leaveNow = await listener.subscribe({
          onEvent: (payload) => send(`data: ${payload}\n\n`),
          onDrop: () => finish(RECONNECT_AFTER_DROP_MS),
        })
      } catch {
        // The listener has logged it; the browser tries again later.
        return finish(RECONNECT_AFTER_DROP_MS)
      }
      if (closed) return leaveNow() // the tab left while we were connecting
      leave = leaveNow
      send('event: ready\ndata: {}\n\n')
      heartbeat = setInterval(() => send(': keepalive\n\n'), heartbeatMs)
    },
    cancel() {
      finish()
    },
  })

  return new Response(stream, {
    headers: {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
    },
  })
}
