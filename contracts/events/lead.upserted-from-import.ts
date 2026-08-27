import { z } from 'zod'

// Emitted by Agent A during importer commit, one per row upserted, on channel
// `crm_lead_sync`. Consumed by Agent D (thread reconcile) and A's own activity
// projector. NO `eventName` / `type` discriminant — channel is the routing
// signal.
export const LeadUpsertedFromImportEvent = z.object({
  leadId: z.string(),
  sourceLabel: z.string(),
  importBatchId: z.string(),
  correlationId: z.string(),
})

export type LeadUpsertedFromImportEvent = z.infer<
  typeof LeadUpsertedFromImportEvent
>
