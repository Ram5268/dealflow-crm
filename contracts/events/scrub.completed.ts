import { z } from 'zod'

// Emitted by Agent C on channel `crm_scrub`, inside the same transaction as the
// ScrubLog inserts / suppression writes. camelCase field names — never
// snake_case. NO `eventName` / `type` discriminant — channel is the routing
// signal.
export const ScrubCompletedEvent = z.object({
  phoneCount: z.number().int(),
  blockedCount: z.number().int(),
  checkedAt: z.string(), // ISO 8601 UTC
  correlationId: z.string(), // uuid v4
})

export type ScrubCompletedEvent = z.infer<typeof ScrubCompletedEvent>
