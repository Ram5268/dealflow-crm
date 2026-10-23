import { dialingEnabled } from "@/lib/telephony/dialingSwitch";
import { sharedCallListener } from "@/lib/telephony/stream/listener";
import { callStreamResponse } from "@/lib/telephony/stream/sse";

export const dynamic = "force-dynamic";
// The stream ends itself before this (src/lib/telephony/stream/sse.ts), so
// Vercel never has to stop the function; the browser reconnects on its own.
export const maxDuration = 300;

/**
 * SSE bridge for the `crm_call` channel. Every emission goes to the browser as
 * `data: <json>\n\n`; the softphone bar and the dialer dispatch on `type`
 * (call.connected / call.completed).
 *
 * Brief 50 PR 1 (open item 6.1; finding M1 of the 2026-10-05 audit),
 * engineering precautions:
 *  - While calling is off (DIALING_ENABLED is not 'true', Brief 37) the route
 *    answers 204 No Content and touches no database. A 204 tells the browser's
 *    EventSource to stop: it does not reconnect.
 *  - While calling is on, every open stream on this server instance shares one
 *    `LISTEN crm_call` connection, which has an error handler and is let go
 *    when the last stream closes (src/lib/telephony/stream/listener.ts).
 *
 * Read-only: this only listens. It never reads or changes the calling switch's
 * setting beyond `dialingEnabled()`.
 */
export async function GET(req: Request): Promise<Response> {
  if (!dialingEnabled()) {
    return new Response(null, { status: 204, headers: { "cache-control": "no-store" } });
  }
  return callStreamResponse(sharedCallListener(), { signal: req.signal });
}
