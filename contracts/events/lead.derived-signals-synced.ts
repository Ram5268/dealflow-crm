import { z } from 'zod'

// Emitted by Agent A after the DealFlow signal-sync cron completes, on channel
// `crm_lead_sync`. NO `eventName` / `type` discriminant — channel is the
// routing signal.
export const LeadDerivedSignalsSyncedEvent = z.object({
  count: z.number().int(),
  syncedAt: z.string(), // ISO 8601 UTC
  correlationId: z.string(),
})

export type LeadDerivedSignalsSyncedEvent = z.infer<
  typeof LeadDerivedSignalsSyncedEvent
>
