import { Client } from "pg";
import { logger } from "@/lib/logger";

export const dynamic = "force-dynamic";

/**
 * SSE bridge for the `crm_call` channel. A dedicated pg LISTEN client forwards
 * every emission to the browser as `data: <json>\n\n`. The AmmunitionPanel /
 * DialerShell dispatch on `type` (call.connected / call.completed). Streaming is
 * verified in the device smoke, not unit tests.
 */
export async function GET(): Promise<Response> {
  const encoder = new TextEncoder();
  const client = new Client({ connectionString: process.env.DATABASE_URL_MAIN });

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      try {
        await client.connect();
        client.on("notification", (msg) => {
          if (msg.channel === "crm_call" && msg.payload) {
            controller.enqueue(encoder.encode(`data: ${msg.payload}\n\n`));
          }
        });
        await client.query("LISTEN crm_call");
        controller.enqueue(encoder.encode(`event: ready\ndata: {}\n\n`));
      } catch (err) {
        logger.error({ err }, "crm_call SSE bridge failed to start");
        controller.error(err);
      }
    },
    async cancel() {
      await client.end().catch(() => {});
    },
  });

  return new Response(stream, {
    headers: {
      "content-type": "text/event-stream",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
    },
  });
}
