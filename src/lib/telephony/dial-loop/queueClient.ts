import { QueueResponseSchema, type QueueResponse } from "./schemas";
import { logger } from "@/lib/logger";

export interface QueueDeps {
  baseUrl: string;
  fetchImpl?: typeof fetch;
}

/**
 * Fetch the ranked queue from Agent A (`GET /api/queue`). Parsed with a
 * passthrough schema. `stale:true` is logged but NOT a reason to refuse dialing
 * (A's ranker being late is A's problem, brief §8.2). Throws on transport/parse
 * failure — the session loop decides how to react (pause on empty/error).
 */
export async function getQueue(
  deps: QueueDeps,
  viewId: string,
  limit = 50,
): Promise<QueueResponse> {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const url = `${deps.baseUrl}/api/queue?viewId=${encodeURIComponent(viewId)}&limit=${limit}`;
  const res = await fetchImpl(url);
  if (!res.ok) throw new Error(`queue fetch failed: ${res.status}`);
  const parsed = QueueResponseSchema.safeParse(await res.json());
  if (!parsed.success) throw new Error(`queue parse failed: ${parsed.error.message}`);
  if (parsed.data.stale) {
    logger.warn({ staleReason: parsed.data.staleReason }, "queue is stale — proceeding to dial anyway");
  }
  return parsed.data;
}
