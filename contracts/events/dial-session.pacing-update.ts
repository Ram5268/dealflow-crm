import { z } from 'zod'

// Emitted by Agent B's pacing worker on channel `crm_call` every 60s. Consumer
// is the Ops dashboard (post-MVP). Agent A subscribes to `crm_call` but ignores
// unknown `type` values. Carries a `type` discriminant; no `eventName` field.
export const PacingUpdateEvent = z.object({
  type: z.literal('dial-session.pacing-update'),
  dialSessionId: z.string(),
  currentLineCount: z.number().int(),
  abandonment30d: z.number(), // fraction, 0.0–1.0
  correlationId: z.string().uuid(),
})

export type PacingUpdateEvent = z.infer<typeof PacingUpdateEvent>
