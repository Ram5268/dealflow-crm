import { CallableResponseSchema, KNOWN_REASON_CODES, type CallableResult } from "./schemas";
import { logger } from "@/lib/logger";

/**
 * Inline compliance check against Agent C's `POST /api/compliance/callable-now`.
 *
 * FAIL-CLOSED is the whole point: on ANY error (timeout, non-2xx, network,
 * malformed body) EVERY requested phone is treated as `callable:false`. We never
 * dial without a positive-safe signal.
 *
 * `atInstant` is deliberately NOT sent — C evaluates against wall-clock-now,
 * which is authoritative at the dial-loop moment. Batch is capped at 100
 * (chunked); B's dial loop only ever sends 1, so the cap never bites there.
 */
export interface ComplianceDeps {
  baseUrl: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

function failClosed(ids: string[]): CallableResult[] {
  return ids.map((id) => ({
    contactPhoneId: id,
    phone: "",
    callable: false,
    reasons: ["internal_error"],
  }));
}

async function checkChunk(deps: ComplianceDeps, ids: string[]): Promise<CallableResult[]> {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), deps.timeoutMs ?? 5000);
  try {
    const res = await fetchImpl(`${deps.baseUrl}/api/compliance/callable-now`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ contactPhoneIds: ids }),
      signal: controller.signal,
    });
    if (!res.ok) {
      logger.warn({ status: res.status }, "callable-now non-2xx — fail-closed");
      return failClosed(ids);
    }
    const parsed = CallableResponseSchema.safeParse(await res.json());
    if (!parsed.success) {
      logger.warn({ err: parsed.error.message }, "callable-now malformed — fail-closed");
      return failClosed(ids);
    }
    // Sentry-warn on any reason code outside the frozen enum (C-side drift).
    for (const r of parsed.data.results) {
      for (const reason of r.reasons) {
        if (!KNOWN_REASON_CODES.has(reason)) {
          logger.warn({ reason, contactPhoneId: r.contactPhoneId }, "unknown REASON_CODE from compliance — possible C drift");
        }
      }
    }
    return parsed.data.results;
  } catch (err) {
    logger.warn({ err }, "callable-now threw/timed out — fail-closed");
    return failClosed(ids);
  } finally {
    clearTimeout(timeout);
  }
}

/** Check callable status for up to N phones, chunked at 100. Fail-closed. */
export async function checkCallable(
  deps: ComplianceDeps,
  contactPhoneIds: string[],
): Promise<CallableResult[]> {
  if (contactPhoneIds.length === 0) return [];
  const out: CallableResult[] = [];
  for (let i = 0; i < contactPhoneIds.length; i += 100) {
    const chunk = contactPhoneIds.slice(i, i + 100);
    out.push(...(await checkChunk(deps, chunk)));
  }
  return out;
}

/** Convenience: is this single phone callable right now? Fail-closed. */
export async function isCallable(
  deps: ComplianceDeps,
  contactPhoneId: string,
): Promise<{ callable: boolean; reasons: string[] }> {
  const [result] = await checkCallable(deps, [contactPhoneId]);
  if (!result) return { callable: false, reasons: ["internal_error"] };
  return { callable: result.callable, reasons: result.reasons };
}
