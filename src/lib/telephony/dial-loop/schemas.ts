import { z } from "zod";
import { REASON_CODES } from "../../../../contracts/http/reason-codes";

/**
 * Consumer Zod schemas for the cross-slice HTTP contracts. `.passthrough()`
 * everywhere so Agent A / Agent C can add fields without breaking B's parse
 * (brief §8.2). We only bind the fields B actually uses at dial time.
 */

// GET /api/queue (Agent A) — brief §8.2 / contracts/http/queue.json.
// NOTE: `primaryPhoneId` is required by the brief (it's the contactPhoneId we
// pass to callable-now) but is only additionalProperties in the frozen
// queue.json. Parsed optional; a lead without it cannot be compliance-checked
// and is skipped fail-closed. Flagged to the planner.
export const QueueLeadSchema = z
  .object({
    leadId: z.string(),
    contactId: z.string(),
    primaryPhoneId: z.string().optional(),
    primaryPhoneE164: z.string(),
    displayName: z.string().optional(),
    timezone: z.string().nullable().optional(),
    ammunition: z.object({}).passthrough().optional(),
  })
  .passthrough();

export const QueueResponseSchema = z
  .object({
    view: z.object({ id: z.string(), name: z.string() }),
    leads: z.array(QueueLeadSchema),
    stale: z.boolean().optional(),
    staleReason: z.string().nullable().optional(),
    excludedNoPhone: z.number().int().optional(),
    excludedCompliance: z.number().int().optional(),
    generatedAt: z.string(),
  })
  .passthrough();

export type QueueLead = z.infer<typeof QueueLeadSchema>;
export type QueueResponse = z.infer<typeof QueueResponseSchema>;

// POST /api/compliance/callable-now (Agent C). reasons drawn from REASON_CODES;
// unknown values are tolerated at parse (kept as string) so we can Sentry-warn
// on drift while still honoring the `callable` boolean fail-closed.
export const CallableResultSchema = z
  .object({
    contactPhoneId: z.string(),
    phone: z.string(),
    callable: z.boolean(),
    reasons: z.array(z.string()),
    reasonDetails: z.object({}).passthrough().optional(),
  })
  .passthrough();

export const CallableResponseSchema = z
  .object({ results: z.array(CallableResultSchema) })
  .passthrough();

export type CallableResult = z.infer<typeof CallableResultSchema>;

export const KNOWN_REASON_CODES: ReadonlySet<string> = new Set(REASON_CODES);
