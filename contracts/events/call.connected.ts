import { z } from 'zod'

// Emitted by Agent B on channel `crm_call`, in the same transaction as the
// state change. Carries a `type` discriminant (planner lock §8.3 item 4) and a
// correlationId. No `eventName` field.
export const CallConnectedEvent = z.object({
  type: z.literal('call.connected'),
  callId: z.string(),
  dialSessionId: z.string(),
  leadId: z.string().nullable(),
  contactId: z.string().nullable(),
  remotePhone: z.string(), // E.164
  connectedAt: z.string(), // ISO8601 UTC
  correlationId: z.string().uuid(),
})

export type CallConnectedEvent = z.infer<typeof CallConnectedEvent>
