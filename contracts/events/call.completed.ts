import { z } from 'zod'

// Emitted by Agent B on channel `crm_call`, same transaction as the state
// change. `cost` is a DECIMAL-AS-STRING on the wire — Prisma Decimal serializes
// as string. Agent A's activity projector accepts it as string (planner lock
// §8.3 item 2). Do NOT coerce to number here. No `eventName` field.
export const CallCompletedEvent = z.object({
  type: z.literal('call.completed'),
  callId: z.string(),
  disposition: z.enum([
    'answered', 'vm-answer', 'vm-left', 'busy',
    'blocked', 'error', 'abandoned', 'no-answer',
  ]),
  duration: z.number().int().nullable(), // seconds
  cost: z.string().nullable(), // decimal-as-string (see note above)
  outcomeId: z.string().nullable().optional(),
  correlationId: z.string().uuid(),
})

export type CallCompletedEvent = z.infer<typeof CallCompletedEvent>
