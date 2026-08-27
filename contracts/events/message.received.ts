import { z } from 'zod'

// Emitted by Agent D on channel `crm_message` for every inbound email or SMS
// after the Message row is inserted. Payload is EXACTLY these fields
// (SHARED_CONTEXT §5). NO `eventName` field and NO `type` discriminant — the
// channel name is the routing signal. Consumers (Agent A activity projector)
// must not rely on a discriminant being present.
//
// NOTE: Agent D's brief imports this from `contracts/events/message-received.ts`
// (dashed). A re-export shim at that path points here — this dotted file is the
// single source of truth. See PREFLIGHT deviation note in briefs/.
export const MessageReceivedEvent = z.object({
  messageId: z.string(),
  channel: z.enum(['email', 'sms']),
  contactId: z.string().optional(),
  leadId: z.string().optional(),
  correlationId: z.string(),
})

export type MessageReceivedEvent = z.infer<typeof MessageReceivedEvent>
